// One card, two hosts, and the reason this is a string.
//
// A widget in this server has to run in two worlds that disagree about
// everything except the HTML: OpenAI's Apps SDK injects a `window.openai`
// object, and MCP Apps (SEP-1865) injects nothing at all and expects the iframe
// to speak JSON-RPC to its parent over postMessage. Written twice, the two
// paths drift — src/offer-card.mjs already carries one of them inline, and its
// deny button does something subtly different from its approve button because
// of it.
//
// So the transport is written once, here, as the source text every card embeds.
// It is a template string rather than a module because a UI resource is ONE
// self-contained document: the host renders the HTML in a sandboxed iframe with
// no network of its own — both cards declare an empty CSP on purpose — so there
// is nothing to import from.
//
// What a card gets is four calls and no host detection:
//
//   apiosk.onData(fn)          fn(structuredContent) now and on every update
//   apiosk.callTool(name,args) resolves with the tool's structuredContent
//   apiosk.openLink(url)       opens outside the iframe, or returns false
//   apiosk.say(text)           puts a message in the conversation as the user
//
// `apiosk.can.callTool` and `apiosk.can.say` say whether the host supports
// them, because a button that silently does nothing is worse than a button that
// is not there.

/**
 * The bridge, as browser source.
 *
 * MCP Apps handshake, in order: send `ui/initialize`, then the
 * `ui/notifications/initialized` notification, then wait for
 * `ui/notifications/tool-result` — the host delivers the tool's output as a
 * notification rather than as a global, so a card that only reads a global
 * renders blank there forever.
 */
export const APIOSK_UI_BRIDGE = `
(()=>{
const listeners=[],inputListeners=[];let data=null,input=null,dataKey=null,localState=null,pending=new Map(),rpcId=0,mcp=false,host={};
// Hosts may resend the original tool snapshot when widget state or layout
// changes. Replaying it would overwrite a newer in-card tool response and
// cancel the execution timer immediately after approval.
function emit(v){if(v==null)return;v=restoredView(v);if(localState?.state_ref===v?.state?.state_ref&&Number(v?.state?.revision)<=Number(localState?.revision))return;if(data?.state?.state_ref&&data.state.state_ref===v?.state?.state_ref&&Number(v.state.revision)<Number(data.state.revision))return;let key;try{key=JSON.stringify(v)}catch(e){}if(key!==undefined&&key===dataKey)return;dataKey=key;data=v;for(const fn of listeners){try{fn(v)}catch(e){}}}
function emitInput(v){if(v==null)return;input=v;for(const fn of inputListeners){try{fn(v)}catch(e){}}}
function unwrap(r){if(r&&typeof r==='object'){if(r.structuredContent)return r.structuredContent;
 if(Array.isArray(r.content))for(const block of r.content){if(block?.type==='text'&&typeof block.text==='string'){try{const value=JSON.parse(block.text);if(value&&typeof value==='object')return value}catch(e){}}}}
 return r}
// ---- MCP Apps (SEP-1865): JSON-RPC over postMessage to the host frame -------
function send(msg){try{window.parent.postMessage(msg,'*')}catch(e){}}
function rpc(method,params){return new Promise((resolve,reject)=>{const id=++rpcId;
 const timer=setTimeout(()=>{if(pending.has(id)){pending.delete(id);reject(new Error('timeout'))}},180000);
 pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params:params||{}})})}
window.addEventListener('message',event=>{if(event.source!==window.parent)return;const msg=event.data;
 if(!msg||msg.jsonrpc!=='2.0')return;
 if(msg.id!=null&&pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);
  clearTimeout(p.timer);
  msg.error?p.reject(new Error(msg.error.message||'host error')):p.resolve(msg.result);return}
 if(msg.method==='ui/notifications/tool-input'){emitInput(msg.params);return}
 if(msg.method==='ui/notifications/tool-result'){emit(unwrap(msg.params));return}
 if(msg.method==='ui/notifications/tool-cancelled'){emit({status:'cancelled'});return}});
// ---- OpenAI Apps SDK: globals plus an event ---------------------------------
function restoredView(raw){const o=window.openai,saved=o?.widgetState?.privateContent?.apioskResult??o?.widgetState?.result;
 // Keep the last server-returned view for this card across remounts. This is
 // a display cache only: the card still recovers server state and never starts
 // a paid step from mounting or from persisted widget state.
 if(saved?.state?.state_ref&&saved.state.state_ref===raw?.state?.state_ref&&Number(saved.state.revision)>=Number(raw.state.revision))return saved;
 return raw}
function openaiData(){const o=window.openai;return o?(o.toolOutput??o.structuredContent??null):null}
window.addEventListener('openai:set_globals',e=>{const g=e.detail?.globals??e.detail;
 if(g&&Object.prototype.hasOwnProperty.call(g,'toolInput'))emitInput(g.toolInput);
 if(g&&Object.prototype.hasOwnProperty.call(g,'toolOutput'))emit(g.toolOutput)});
// ---- one surface over both ---------------------------------------------------
const api={
 get data(){return data},
 can:{callTool:false,say:false,openLink:false,purchase:false,autoFollowUp:false},
 onInput(fn){inputListeners.push(fn);if(input!=null){try{fn(input)}catch(e){}}},
 onData(fn){listeners.push(fn);if(data!=null){try{fn(data)}catch(e){}}},
 async callTool(name,args){
  if(window.openai&&window.openai.callTool)return unwrap(await window.openai.callTool(name,args||{}));
  if(mcp)return unwrap(await rpc('tools/call',{name,arguments:args||{}}));
  throw new Error('This host cannot run a tool from the card.')},
 async openLink(url){
  try{if(new URL(url).protocol!=='https:')return false}catch{return false}
  if(window.openai&&window.openai.openExternal){window.openai.openExternal({href:url});return true}
  if(mcp){try{await rpc('ui/open-link',{url});return true}catch(e){return false}}
  return false},
 async say(text){
  if(window.openai&&window.openai.sendFollowUpMessage){
   await window.openai.sendFollowUpMessage({prompt:text,scrollToBottom:true});return true}
  if(mcp){try{const result=await rpc('ui/message',{role:'user',content:[{type:'text',text}]});return !result?.isError}catch(e){return false}}
  return false},
  async context(value){
  // In-card tool responses are newer than the original host snapshot, even
  // when saving consent did not change the task revision. Explicit server
  // refreshes still render directly; this guard only rejects host replays.
  if(value?.state){data=value;localState=value.state;try{dataKey=JSON.stringify(value)}catch(e){}}
  let stored=false;if(window.openai?.setWidgetState){try{window.openai.setWidgetState({...window.openai.widgetState,modelContent:{status:value?.status,state_ref:value?.state?.state_ref,billing:value?.billing},privateContent:{...window.openai.widgetState?.privateContent,apioskResult:value}});stored=true}catch(e){}}
  if(mcp&&host.updateModelContext){const summary={status:value?.status,state_ref:value?.state?.state_ref,billing:value?.billing,result:value?.result,errors:value?.errors};let contextText=JSON.stringify(summary);if(contextText.length>24000)contextText=JSON.stringify({status:value?.status,state_ref:value?.state?.state_ref,billing:value?.billing,note:'Read the saved task to retrieve its result.'});await rpc('ui/update-model-context',{content:[{type:'text',text:contextText}],structuredContent:value});return true}
  return stored},
 // Cards grow when a list renders. A host sizing an iframe once shows the first
 // two rows of six and no scrollbar.
 resize(){const width=Math.ceil(document.documentElement.scrollWidth),height=Math.ceil(document.documentElement.scrollHeight);
  if(window.openai&&window.openai.notifyIntrinsicHeight){try{window.openai.notifyIntrinsicHeight(height)}catch(e){}}
  if(mcp)send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width,height}})}};
window.apiosk=api;
(async()=>{
 if(window.openai){api.can={callTool:!!window.openai.callTool,say:!!window.openai.sendFollowUpMessage,openLink:!!window.openai.openExternal,purchase:!!window.openai.callTool,autoFollowUp:!!window.openai.sendFollowUpMessage};emitInput(window.openai.toolInput);emit(openaiData())}
 if(typeof ResizeObserver!=='undefined')new ResizeObserver(()=>api.resize()).observe(document.documentElement);
 if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>api.resize());else setTimeout(()=>api.resize(),0);
 if(window.parent===window)return;
 try{
  const result=await rpc('ui/initialize',{appInfo:{name:'Apiosk',version:'1.8.0'},protocolVersion:'2026-01-26',appCapabilities:{}});
  mcp=true;host=(result&&result.hostCapabilities)||{};
  api.can={callTool:!!host.serverTools,say:!!host.message,openLink:!!host.openLinks,purchase:!!host.serverTools&&!/claude/i.test(result?.hostInfo?.name||''),autoFollowUp:!!window.openai?.sendFollowUpMessage&&!/claude/i.test(result?.hostInfo?.name||'')};
  send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
 }catch(e){/* not an MCP Apps host: the OpenAI path above, or nothing */}
})();
})();
`;

/**
 * The metadata every Apiosk UI resource carries.
 *
 * BOTH VOCABULARIES, because the two hosts read different keys for the same
 * three facts and a resource that answers only one of them renders in only one
 * of them. The CSP is SET AND EMPTY on purpose: these cards fetch nothing —
 * no script, style, font, image or endpoint — so the policy permits nothing
 * outward, and paid provider data reaches the card only as tool output that the
 * server already fetched.
 *
 * @param {string} description  what a reviewer and a host see the card do
 */
export function uiResourceMeta(description) {
  return {
    ui: {
      prefersBorder: true,
      domain: "https://mcp.apiosk.com",
      csp: { connectDomains: [], resourceDomains: [] },
    },
    "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
    "openai/widgetDomain": "https://mcp.apiosk.com",
    "openai/widgetPrefersBorder": true,
    "openai/widgetDescription": description,
  };
}

/**
 * The shared look: system fonts, the host's own light/dark, one card shell.
 *
 * `color-scheme: light dark` with `Canvas`/`CanvasText` rather than a palette,
 * because these render inside somebody else's product and a card that brings
 * its own white background is a white rectangle in a dark conversation.
 */
export const APIOSK_UI_STYLE = `
@font-face{font-family:Inter;src:url("https://mcp.apiosk.com/brand/inter-latin-500-normal.woff2") format("woff2");font-style:normal;font-weight:500;font-display:swap}
@font-face{font-family:Inter;src:url("https://mcp.apiosk.com/brand/inter-latin-600-normal.woff2") format("woff2");font-style:normal;font-weight:600;font-display:swap}
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;--apiosk-accent:#6349db;--apiosk-accent-fg:#fff;--apiosk-accent-line:rgb(99 73 219/.4);--apiosk-accent-wash:rgb(99 73 219/.07)}
@media(prefers-color-scheme:dark){:root{--apiosk-accent:#c3a0ff;--apiosk-accent-fg:#25153c;--apiosk-accent-line:rgb(195 160 255/.45);--apiosk-accent-wash:rgb(195 160 255/.12)}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:CanvasText;font-weight:500;letter-spacing:-.011em;-webkit-font-smoothing:antialiased}
.card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:16px;padding:16px;background:color-mix(in srgb,Canvas 96%,transparent)}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.58}
h2{font-size:17px;line-height:1.25;margin:2px 0 0;font-weight:600;letter-spacing:-.025em}
.meta,.hint,.status{font-size:12px;line-height:1.45;opacity:.72}
.status{margin-top:12px;min-height:18px}.status.error{color:#b94848;opacity:1}.status.ok{color:#167a50;opacity:1}
button{border:0;border-radius:10px;padding:10px 12px;font:inherit;font-weight:600;letter-spacing:-.016em;cursor:pointer}
.primary{background:var(--apiosk-accent);color:var(--apiosk-accent-fg)}.secondary{background:color-mix(in srgb,CanvasText 9%,transparent);color:CanvasText}
button:disabled{opacity:.5;cursor:default}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.hidden{display:none}
`;
