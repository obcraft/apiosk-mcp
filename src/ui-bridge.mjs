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
const listeners=[];let data=null,pending=new Map(),rpcId=0,mcp=false,host={};
function emit(v){if(v==null)return;data=v;for(const fn of listeners){try{fn(v)}catch(e){}}}
function unwrap(r){if(r&&typeof r==='object'){if(r.structuredContent)return r.structuredContent;
 if(Array.isArray(r.content)&&r.content[0]&&r.content[0].text){try{return JSON.parse(r.content[0].text)}catch(e){return r}}}
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
 if(msg.method==='ui/notifications/tool-result'){emit(unwrap(msg.params));return}
 if(msg.method==='ui/notifications/tool-cancelled'){emit({status:'cancelled'});return}});
// ---- OpenAI Apps SDK: globals plus an event ---------------------------------
function openaiData(){const o=window.openai;return o?(o.toolOutput??o.structuredContent??null):null}
window.addEventListener('openai:set_globals',e=>{const d=e.detail;
 emit((d&&d.globals&&d.globals.toolOutput)??(d&&d.toolOutput)??openaiData())});
// ---- one surface over both ---------------------------------------------------
const api={
 get data(){return data},
 can:{callTool:false,say:false,openLink:false,purchase:false},
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
  if(mcp&&host.updateModelContext){await rpc('ui/update-model-context',{structuredContent:value});return true}
  if(window.openai&&window.openai.setWidgetState){window.openai.setWidgetState({result:value});return true}
  return false},
 // Cards grow when a list renders. A host sizing an iframe once shows the first
 // two rows of six and no scrollbar.
 resize(){if(!mcp)return;
  send({jsonrpc:'2.0',method:'ui/notifications/size-changed',params:{width:Math.ceil(document.documentElement.scrollWidth),height:Math.ceil(document.documentElement.scrollHeight)}})}};
window.apiosk=api;
(async()=>{
 if(window.openai){api.can={callTool:!!window.openai.callTool,say:!!window.openai.sendFollowUpMessage,openLink:!!window.openai.openExternal,purchase:!!window.openai.callTool};emit(openaiData())}
 if(window.parent===window)return;
 try{
  const result=await rpc('ui/initialize',{appInfo:{name:'Apiosk',version:'1.8.0'},protocolVersion:'2026-01-26',appCapabilities:{}});
  mcp=true;host=(result&&result.hostCapabilities)||{};
  api.can={callTool:!!host.serverTools,say:!!host.message,openLink:!!host.openLinks,purchase:!!host.serverTools&&!/claude/i.test(result?.hostInfo?.name||'')};
  send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});
  new ResizeObserver(()=>api.resize()).observe(document.documentElement);
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
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}
body{margin:0;padding:12px;background:transparent;color:CanvasText}
.card{border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:16px;padding:16px;background:color-mix(in srgb,Canvas 96%,transparent)}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.58}
h2{font-size:17px;line-height:1.25;margin:2px 0 0}
.meta,.hint,.status{font-size:12px;line-height:1.45;opacity:.72}
.status{margin-top:12px;min-height:18px}.status.error{color:#b94848;opacity:1}.status.ok{color:#167a50;opacity:1}
button{border:0;border-radius:10px;padding:10px 12px;font:inherit;font-weight:700;cursor:pointer}
.primary{background:#167a50;color:white}.secondary{background:color-mix(in srgb,CanvasText 9%,transparent);color:CanvasText}
button:disabled{opacity:.5;cursor:default}
.actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}
.hidden{display:none}
`;
