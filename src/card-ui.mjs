// Reuse the original embedded components, styles, input forms and result views.
// Only the protocol adapter changes: all operations go through MCP 2's durable
// request/approval journal rather than the original server's tool signatures.
import { gatewayV2CardHtml, gatewayV2CardMeta } from './ask-ui/gateway-v2-card.mjs';

export const CARD_URI = 'ui://apiosk/mcp-2-ask-v2.html';
export const CHATGPT_CARD_URI = 'ui://apiosk/mcp-2-ask-v2-chatgpt.html';
export const CURRENT_CARD_COMPATIBILITY_URIS = ['ui://apiosk/mcp-2-ask-v1.html', 'ui://apiosk/mcp-2-ask-v1-chatgpt.html'];
export const CARD_READ_TOOL = 'apiosk_card';
export const CARD_APPROVE_TOOL = 'apiosk_card_approve';
export const cardToolMeta = { ui: { resourceUri: CARD_URI, visibility: ['model', 'app'] }, 'openai/outputTemplate': CHATGPT_CARD_URI,
  'openai/widgetAccessible': true, 'openai/visibility': 'public' };
// These current catalog assets were absent from MCP1's historical image CSP.
// Keep a fixed list; source payloads cannot grant arbitrary remote origins.
const CURRENT_LOGO_ORIGINS = ['https://app.apiosk.com', 'https://www.bodemloket.nl', 'https://www.openwebninja.com', 'https://www.crunchbase.com'];
// srcdoc inherits the tester's parent policy. Both parent and card must use
// this exact fixed list; the card cannot relax a restrictive parent policy.
export const SOURCE_LOGO_ORIGINS = Object.freeze([...new Set([
  ...gatewayV2CardMeta().ui.csp.resourceDomains, ...CURRENT_LOGO_ORIGINS,
])]);

const ADAPTER = `
// Transport shim. Source records never select the request or spending ceiling.
let mcp2Request=null,mcp2Approval=null;
const mcp2Remember=data=>{if(data?._mcp2?.request_id){mcp2Request=data._mcp2.request_id;mcp2Approval=data._mcp2.approval||null}return data};
window.apiosk.onData(mcp2Remember);
const mcp2OriginalCall=window.apiosk.callTool.bind(window.apiosk);
window.apiosk.callTool=async(name,args={})=>{
 if(!mcp2Request)throw new Error('Reopen this saved Ask request before continuing.');
 const paid=['apiosk_approve','apiosk_external_approve','approve_basket'].includes(name);
 const next=await mcp2OriginalCall(paid?'${CARD_APPROVE_TOOL}':'${CARD_READ_TOOL}',{request_id:mcp2Request,operation:name,args,...(paid?{approval:mcp2Approval}:{} )});
 if(next?.error&&!next?._mcp2)throw new Error(next.error.message||'The saved request could not be updated.');
 return mcp2Remember(next);
};
// Save live Gateway changes through the same scoped state journal before the
// UI can act on their newer action IDs or quotes. Events themselves never buy.
let mcp2LiveRead=null;
async function mcp2AcceptLiveTask(next){
 if(!next?.state?.state_ref||mcp2LiveRead)return;
 const ref=next.state.state_ref;
 mcp2LiveRead=window.apiosk.callTool('apiosk_status',{task_ref:ref});
 try{const saved=await mcp2LiveRead;if(output?.state?.state_ref===ref)acceptResponse(saved)}
 catch{showFeedback('Use Check status to refresh the saved request.')}
 finally{mcp2LiveRead=null}
}
`;

// Keep MCP 1's source-basket display, but use one backend-owned MCP 2 approval.
const BASKET_ADAPTER = `
async function prepareSourceBasket(selections){
 if(busy)return;busy=true;syncSourceSelection();showFeedback('Preparing one total price for your selected sources…');
 try{const next=await window.apiosk.callTool('prepare_basket',{selections,external:[...externalBasketSources.values()]});render(next);void window.apiosk.context(next).catch(()=>{})}
 catch(error){showFeedback(error?.message||'The selection could not be priced.','error')}
 finally{busy=false;syncSourceSelection()}
}
async function refreshSourceBasket(data){
 if(busy)return;busy=true;
 try{const next=await window.apiosk.callTool('status_basket',{});render(next);void window.apiosk.context(next).catch(()=>{})}
 catch(error){showFeedback(error?.message||'The saved selection could not be read.','error')}
 finally{busy=false}
}
async function approveSourceBasket(data){
 if(busy||output!==data||!data?._mcp2?.approval)return;
 busy=true;showFeedback('Saving your approval…');
 try{const next=await window.apiosk.callTool('approve_basket',{});render(next);void window.apiosk.context(next).catch(()=>{})}
 catch(error){showFeedback(error?.message||'Approval could not be confirmed. Check saved status.','error')}
 finally{busy=false}
}
async function retrySourceBasket(data){
 if(busy)return;busy=true;
 try{render(await window.apiosk.callTool('retry_preparation',{}))}catch(error){showFeedback(error.message,'error')}finally{busy=false}
}
async function refreshSourceBasketQuotes(data){
 if(busy)return;busy=true;
 try{render(await window.apiosk.callTool('requote_basket',{}))}catch(error){showFeedback(error.message,'error')}finally{busy=false}
}
const mcp2Render=render;
render=function(data){
 mcp2Remember(data);
 if(data?.view==='source_basket')for(const entry of data.entries||[])if(!entry.uncertain&&entry.response)basketVerified.add(basketProof(entry));
 mcp2Render(data);
};
const mcp2AcceptResponse=acceptResponse;
acceptResponse=function(next){
 if(['source_search','source_basket','conversation'].includes(next?.view)){render(next);void window.apiosk.context(next).catch(()=>{});return}
 return mcp2AcceptResponse(next);
};
`;

// These notice fields contain instructions for the host AI, not source
// findings or buyer guidance. Keep them in the protocol response without
// printing tool names, request fields and orchestration steps in the card.
const PROTOCOL_NOTICE_RENDERERS = [
  "if(data.notice)section('About these results').append(el('p','meta',data.notice));",
  "if(data.notice)s.append(el('p','meta',data.notice));",
  "if(data.notice)section('About this source').append(el('p','meta',data.notice));",
  "if(data.notice)section('About this purchase').append(el('p','meta',data.notice));",
];
const userFacingHtml = html => PROTOCOL_NOTICE_RENDERERS.reduce((value, fragment) => value.replaceAll(fragment, ''), html);

// Cached MCP1 resources retain the MCP1 action signatures. The private-data
// bridge also lets a current first Ask response render in those cached hosts.
export function createLegacyCardHtml(gatewayUrl = 'http://127.0.0.1:8082') {
  return userFacingHtml(gatewayV2CardHtml(gatewayUrl))
    .replace("function unwrap(r){if(r&&typeof r==='object'){if(r.structuredContent)return r.structuredContent;", "function unwrap(r){if(r&&typeof r==='object'){if(r._meta?.apiosk_card_data)return r._meta.apiosk_card_data;if(r.structuredContent)return r.structuredContent;")
    .replace('o?(o.toolOutput??o.structuredContent??null):null', 'o?(o.toolResponseMetadata?.apiosk_card_data??o.toolOutput??o.structuredContent??null):null')
    .replace('function safeLogo(url){try{const u=new URL(url);', `function safeLogo(url){try{const u=new URL(url);if(u.protocol==='https:'&&${JSON.stringify(CURRENT_LOGO_ORIGINS)}.includes(u.origin))return u.href;`);
}

export function createCardHtml(gatewayUrl = 'http://127.0.0.1:8082') {
  return createLegacyCardHtml(gatewayUrl)
    .replace('   acceptResponse(next);\n  }catch{recover()}', '   void mcp2AcceptLiveTask(next);\n  }catch{recover()}')
    .replace('const byId=id=>', `${ADAPTER}\nconst byId=id=>`)
    .replace('const recoveredCards=new Set();', `${BASKET_ADAPTER}\nconst recoveredCards=new Set();`);
}

export function legacyCardResources(gatewayUrl, { legacyUiMime = false } = {}) {
  const _meta = cardResources(gatewayUrl)[0]._meta;
  const mime = skybridge => skybridge ? 'text/html+skybridge' : 'text/html;profile=mcp-app';
  return [
    ...CURRENT_CARD_COMPATIBILITY_URIS.map(uri => ({ uri, name: 'Apiosk Ask', mimeType: mime(uri.endsWith('-chatgpt.html')), _meta })),
    ...Array.from({ length: 66 }, (_, index) => ({ uri: `ui://apiosk/gateway-v2-card-v${index + 1}.html`, name: 'Apiosk Ask',
      mimeType: mime(index + 1 < 54 && legacyUiMime), _meta })),
    ...Array.from({ length: 20 }, (_, index) => ({ uri: `ui://apiosk/gateway-v2-card-v${index + 11}-chatgpt.html`, name: 'Apiosk Ask for ChatGPT',
      mimeType: mime(true), _meta })),
  ];
}

export function cardResources(gatewayUrl) {
  const _meta = gatewayV2CardMeta(gatewayUrl);
  const origins = [...SOURCE_LOGO_ORIGINS];
  _meta.ui.csp.resourceDomains = origins;
  _meta['openai/widgetCSP'].resource_domains = origins;
  return [
    { uri: CARD_URI, name: 'Apiosk Ask', mimeType: 'text/html;profile=mcp-app', _meta },
    { uri: CHATGPT_CARD_URI, name: 'Apiosk Ask for ChatGPT', mimeType: 'text/html+skybridge', _meta },
  ];
}
