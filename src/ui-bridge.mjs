// One card, two hosts, and the reason this is a string.
//
// A widget in this server has to run in two worlds that disagree about
// everything except the HTML: OpenAI's Apps SDK injects a `window.openai`
// object, and MCP Apps (SEP-1865) injects nothing at all and expects the iframe
// to speak JSON-RPC to its parent over postMessage. Written twice, the two
// paths drift.
//
// So the transport is written once, here, as the source text the card embeds.
// It is a template string rather than a module because a UI resource is ONE
// self-contained document: the host renders the HTML in a sandboxed iframe, so
// there is nothing to import from.
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
function applyTheme(theme){if(theme!=='light'&&theme!=='dark')return;document.documentElement.dataset.theme=theme;document.documentElement.style.colorScheme=theme}
applyTheme(window.openai?.theme);
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
 if(msg.method==='ui/notifications/host-context-changed'){applyTheme(msg.params?.theme);return}
 if(msg.method==='ui/notifications/tool-input'){emitInput(msg.params);return}
 if(msg.method==='ui/notifications/tool-result'){emit(unwrap(msg.params));return}
 // A host cancelling its local tool wait does not prove that the durable
 // Gateway task stopped. Keep the latest task snapshot and its recovery
 // controls; only a Gateway response may set status=cancelled.
 if(msg.method==='ui/notifications/tool-cancelled'){return}});
// ---- OpenAI Apps SDK: globals plus an event ---------------------------------
function restoredView(raw){const o=window.openai,saved=o?.widgetState?.privateContent?.apioskResult??o?.widgetState?.result;
 // Keep the last server-returned view for this card across remounts. This is
 // a display cache only: the card still recovers server state and never starts
 // a paid step from mounting or from persisted widget state.
 if(saved?.state?.state_ref&&saved.state.state_ref===raw?.state?.state_ref&&Number(saved.state.revision)>=Number(raw.state.revision))return saved;
 return raw}
function openaiData(){const o=window.openai;return o?(o.toolOutput??o.structuredContent??null):null}
window.addEventListener('openai:set_globals',e=>{const g=e.detail?.globals??e.detail;
 if(g?.theme)applyTheme(g.theme);
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
  const result=await rpc('ui/initialize',{appInfo:{name:'Apiosk',version:'2.0.0'},protocolVersion:'2026-01-26',appCapabilities:{}});
  mcp=true;host=(result&&result.hostCapabilities)||{};applyTheme(result?.hostContext?.theme);
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

// The App's design tokens (app/src/index.css), both themes. Dark follows the
// host's data-theme, else the system preference, and swaps the whole set.
const LIGHT_TOKENS = "color-scheme:light;--background:#fafafa;--background-2:oklch(.975 .004 265);--surface:oklch(1 0 0);--surface-muted:oklch(.965 .005 265);--surface-soft:#f4f4f5;--card:oklch(1 0 0);--foreground:#303036;--heading:#232329;--muted:oklch(.52 .02 265);--faint:oklch(.62 .018 265);--border:#e9e9ed;--border-2:#dddde3;--border-3:oklch(.82 .01 265);--accent:#6349db;--accent-fg:#fff;--accent-line:rgb(99 73 219/.4);--accent-wash:rgb(99 73 219/.07);--accent-wash-strong:rgb(99 73 219/.13);--secondary:oklch(.96 .006 265);--secondary-fg:oklch(.26 .02 265);--button-primary-bg-hover:#553cc5;--button-secondary-bg:oklch(1 0 0);--button-secondary-fg:oklch(.26 .02 265);--input-bg:oklch(1 0 0);--hover:oklch(.21 .02 265/.05);--success-bg:#e8faf1;--success-fg:#057857;--success-border:#c9efdc;--warning-bg:#fdf5e6;--warning-fg:#b26a12;--warning-border:#f2e2c4;--danger-bg:#fff2f4;--danger-fg:#b42318;--danger-border:#fecdd3";
const DARK_TOKENS = "color-scheme:dark;--background:oklch(.148 .014 265);--background-2:oklch(.172 .014 265);--surface:oklch(.185 .015 265);--surface-muted:oklch(.225 .015 265);--surface-soft:oklch(.258 .015 265);--card:oklch(.185 .015 265);--foreground:oklch(.925 .008 265);--heading:oklch(.975 .004 265);--muted:oklch(.715 .018 265);--faint:oklch(.565 .02 265);--border:rgba(255,255,255,.08);--border-2:rgba(255,255,255,.12);--border-3:rgba(255,255,255,.18);--accent:#c3a0ff;--accent-fg:#25153c;--accent-line:rgb(195 160 255/.45);--accent-wash:rgb(195 160 255/.12);--accent-wash-strong:rgb(195 160 255/.2);--secondary:oklch(.265 .018 265);--secondary-fg:oklch(.93 .008 265);--button-primary-bg-hover:#d2b8ff;--button-secondary-bg:oklch(.225 .015 265);--button-secondary-fg:oklch(.925 .008 265);--input-bg:oklch(.172 .014 265);--hover:rgba(255,255,255,.06);--success-bg:rgba(16,185,129,.14);--success-fg:#6ee7b7;--success-border:rgba(16,185,129,.28);--warning-bg:rgba(251,191,36,.14);--warning-fg:#fbbf24;--warning-border:rgba(251,191,36,.28);--danger-bg:rgba(244,63,94,.14);--danger-fg:#fda4af;--danger-border:rgba(244,63,94,.28)";
const FONT = weight => `@font-face{font-family:Inter;src:url("https://mcp.apiosk.com/brand/inter-latin-${weight}-normal.woff2") format("woff2");font-style:normal;font-weight:${weight};font-display:swap}`;

/**
 * Embedded cards follow the chat host, falling back to the system theme.
 *
 * The App's type rules: Inter 400 body without letter-spacing, 500 for names
 * and headings, 600 only at 16px and 24px; four sizes (12/14/16/24); no
 * uppercase micro-caps; no monospace face. Radii: 6px controls, 8px panels,
 * 12px cards.
 */
export const APIOSK_UI_STYLE = `
${[400, 500, 600].map(FONT).join("\n")}
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;${LIGHT_TOKENS}}
:root[data-theme=dark]{${DARK_TOKENS}}
@media(prefers-color-scheme:dark){:root:not([data-theme=light]){${DARK_TOKENS}}}
*{box-sizing:border-box}body{margin:0;padding:12px;background:transparent;color:var(--foreground);font-size:14px;line-height:20px;font-weight:400;font-feature-settings:normal;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;text-rendering:optimizeLegibility}
h1,h2,h3,h4{color:var(--heading);font-weight:500;margin:0}
pre,code{font:inherit}
::selection{background:var(--accent-wash-strong);color:var(--heading)}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
.card{border:1px solid var(--border-2);border-radius:12px;padding:16px;background:var(--card);color:var(--foreground)}
h2{font-size:16px;line-height:24px;font-weight:600;letter-spacing:-.011em}
.meta,.hint,.status{font-size:12px;line-height:16px;color:var(--muted)}
.status{margin-top:12px;min-height:16px}.status.error{color:var(--danger-fg)}.status.ok{color:var(--success-fg)}
button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:36px;border:1px solid var(--border-2);border-radius:6px;padding:0 12px;background:var(--button-secondary-bg);color:var(--button-secondary-fg);font:inherit;font-size:14px;line-height:20px;font-weight:500;cursor:pointer;transition:background-color .15s,color .15s}
button:hover{background:var(--secondary)}
.primary{border-color:transparent;background:var(--accent);color:var(--accent-fg)}.primary:hover{background:var(--button-primary-bg-hover)}
button:disabled{opacity:.5;cursor:not-allowed}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:16px}
.hidden{display:none}
`;
