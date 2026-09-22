import { V2_CARD_CHOICES } from './gateway-v2-card-choices.mjs';
import { DISPLAY_TEXT } from './display-text.mjs';
import { V2_CBS_STYLE } from './gateway-v2-card-cbs.mjs';
import { V2_CARD_CLARIFICATION } from "./gateway-v2-card-clarification.mjs";
import { formatDisplayMoney } from "./display-money.mjs";
import { V2_CARD_EVENTS } from "./gateway-v2-card-events.mjs";
import { V2_CARD_RESULT } from "./gateway-v2-card-result.mjs";
import { V2_CARD_RESEARCH } from "./gateway-v2-card-research.mjs";
import { V2_RESULT_READY_PROMPT, V2_SOURCES_PRESENTATION } from "./result-presentation.mjs";
import { V2_CARD_ACTIONS } from "./gateway-v2-card-actions.mjs";
import { V2_ACCOUNT_MARKUP, V2_CARD_ACCOUNT, V2_ACCOUNT_STYLE } from "./gateway-v2-card-account.mjs";
import { V2_CARD_SOURCES } from "./gateway-v2-card-sources.mjs";
import { V2_CARD_COMPACT, V2_COMPACT_STYLE } from "./gateway-v2-card-compact.mjs";
import { APIOSK_UI_BRIDGE, APIOSK_UI_STYLE, uiResourceMeta } from "./ui-bridge.mjs";

export const APIO_V2_CARD_URI = "ui://apiosk/gateway-v2-card-v51.html";
export const APIO_V2_CHATGPT_CARD_URI = "ui://apiosk/gateway-v2-card-v17-chatgpt.html";
export const APIO_V2_CARD_LEGACY_URIS = [...Array.from({length:50},(_,i)=>`ui://apiosk/gateway-v2-card-v${i+1}.html`), "ui://apiosk/gateway-v2-card-v11-chatgpt.html", "ui://apiosk/gateway-v2-card-v12-chatgpt.html", "ui://apiosk/gateway-v2-card-v13-chatgpt.html", "ui://apiosk/gateway-v2-card-v14-chatgpt.html", "ui://apiosk/gateway-v2-card-v15-chatgpt.html", "ui://apiosk/gateway-v2-card-v16-chatgpt.html"];

const SOURCE_LOGO_ORIGINS = ["https://mcp.apiosk.com", "https://api.apiosk.com", "https://overheid.io", "https://agentbodega.store", "https://pulse.theaslangroupllc.com", "https://www.browserbase.com", "https://www.cityfalcon.ai", "https://crowdpull.click", "https://eodhd.com", "https://exa.ai", "https://www.gleif.org", "https://www.linkup.so", "https://stableenrich.dev", "https://www.tavily.com", "https://x402.webbersites.com"];

export function gatewayV2CardMeta(gatewayUrl = "https://api.apiosk.com") {
  const gatewayOrigin = new URL(gatewayUrl).origin;
  const meta = uiResourceMeta(
    "Shows Apiosk sources, plan, price, approval, progress, balance and complete source-backed results. The card already displays the details; add only a brief completion note and source citation unless the user explicitly asks for details or analysis. " + V2_SOURCES_PRESENTATION
  );
  delete meta.ui.domain;
  meta.ui.csp.resourceDomains = SOURCE_LOGO_ORIGINS;
  meta["openai/widgetCSP"].resource_domains = SOURCE_LOGO_ORIGINS;
  meta.ui.csp.connectDomains = [...new Set([...(meta.ui.csp.connectDomains || []), gatewayOrigin])];
  meta["openai/widgetCSP"].connect_domains = meta.ui.csp.connectDomains;
  meta["openai/widgetCSP"].redirect_domains = [...new Set(["https://app.apiosk.com", gatewayOrigin])];
  meta.ui.prefersBorder = false;
  meta["openai/widgetPrefersBorder"] = false;
  return meta;
}

export const APIO_V2_CARD_META = gatewayV2CardMeta();

const APIO_V2_CARD_HTML_TEMPLATE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>${APIOSK_UI_STYLE}
${V2_CBS_STYLE}
:root{--apiosk:var(--apiosk-accent);--apiosk-strong:#553cc5;--apiosk-soft:var(--apiosk-accent-wash);--good:#36a577;--bad:#d56071}
html,body{min-height:0!important;height:auto!important}body{padding:2px}.card{padding:0;overflow:hidden;border-radius:14px;box-shadow:none}.shell{padding:14px 15px;background:color-mix(in srgb,CanvasText 2.5%,transparent)}.pill{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:999px;padding:5px 8px;font-size:10px;line-height:1;opacity:.72;text-transform:capitalize}
${V2_ACCOUNT_STYLE}
.hero{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.hero h2{font-size:18px;margin:0}.hero p{margin:5px 0 0}.hero-status{display:flex;flex-direction:column;align-items:flex-end;gap:9px}.amount{text-align:right;white-space:nowrap}.amount b{display:block;font-size:18px;font-weight:600;letter-spacing:-.025em}.amount span{display:block;margin-top:5px;font-size:10px;opacity:.6}
.section{border-top:1px solid color-mix(in srgb,CanvasText 10%,transparent);padding:14px 15px}.plan-mode #sections>.section:first-child{padding:18px}.section-title{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:12px}.section-title h3{font-size:12px;margin:0}.plan-mode #sections>.section:first-child>.section-title h3{font-size:17px;letter-spacing:-.025em}.section-title span{font-size:10px;opacity:.6}
.sources{display:grid;gap:8px}.source{display:grid;grid-template-columns:35px minmax(0,1fr) auto;align-items:center;gap:10px;padding:9px;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);border-radius:12px;background:color-mix(in srgb,CanvasText 2.5%,transparent)}.logo{width:35px;height:35px;border-radius:10px;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);object-fit:contain;background:var(--apiosk-soft)}.fallback{display:grid;place-items:center;color:var(--apiosk);font-weight:600}.source-name{font-size:12px;font-weight:600;letter-spacing:-.018em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-meta{font-size:10px;opacity:.62;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.count{font-size:10px;opacity:.62;white-space:nowrap}.count.unavailable{color:var(--bad);opacity:.85}
.steps{display:grid;gap:14px}.step{display:grid;grid-template-columns:24px minmax(0,1fr);align-items:start;gap:10px}.step-no{padding-top:5px;font-size:11px;opacity:.62}.step-title-line{display:flex;flex-wrap:wrap;align-items:center;gap:7px}.step-title{font-size:13px;font-weight:600;letter-spacing:-.018em}.step-source{display:flex;align-items:center;gap:7px;font-size:11px;opacity:.7;margin-bottom:5px}.logo.mini{width:22px;height:22px;border-radius:7px;font-size:9px;flex:0 0 auto}.source-badge{display:flex;align-items:center;gap:6px;font-size:10px;opacity:.75}.state{font-size:9px;border:1px solid color-mix(in srgb,CanvasText 12%,transparent);border-radius:999px;padding:4px 7px;background:transparent;text-transform:capitalize}.state.completed{color:var(--good);border-color:color-mix(in srgb,var(--good) 28%,transparent);background:color-mix(in srgb,var(--good) 10%,transparent)}.state.failed{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 28%,transparent);background:color-mix(in srgb,var(--bad) 10%,transparent)}.state.running{color:var(--apiosk);border-color:var(--apiosk-accent-line);background:var(--apiosk-soft)}.plan-summary{display:grid;gap:8px;margin-top:18px;font-size:12px}.plan-summary p{margin:0}.plan-summary strong{font-size:15px;letter-spacing:-.02em}.request-section>.section-title{align-items:flex-start;gap:20px;margin-bottom:22px}.request-price{display:grid;gap:4px;text-align:right;flex:0 0 auto}.request-price .price-label{font-size:10px;opacity:.65}.request-price strong{font-size:17px;font-weight:600;letter-spacing:-.02em;white-space:nowrap}.request-price .price-note{font-size:10px;opacity:.65}.plan-actions{margin-top:16px}.plan-actions button{width:auto;min-width:190px}
.notice{font-size:11px;line-height:1.45;padding:10px 11px;border-radius:11px;background:var(--apiosk-soft)}.notice.error{color:var(--bad);background:color-mix(in srgb,var(--bad) 10%,transparent)}
.balances{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.balance{padding:10px;border-radius:11px;background:color-mix(in srgb,CanvasText 5%,transparent)}.balance span{display:block;font-size:9px;opacity:.6}.balance b{display:block;font-size:14px;font-weight:600;letter-spacing:-.02em;margin-top:3px}
.choice-list{display:flex;flex-wrap:wrap;gap:7px}.choice-list button,.actions button{border:1px solid color-mix(in srgb,CanvasText 12%,transparent);background:color-mix(in srgb,CanvasText 5%,transparent);color:CanvasText;font-size:11px;padding:8px 10px}.actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.controls .actions{margin-top:0}.actions .primary{border-color:transparent;background:var(--apiosk);color:var(--apiosk-accent-fg)}.actions .quiet{background:transparent}.field{display:flex;gap:8px}.field input{min-width:0;flex:1;border:1px solid color-mix(in srgb,CanvasText 14%,transparent);border-radius:10px;background:Canvas;color:CanvasText;padding:9px 10px;font:inherit;font-size:12px;outline:none}.field input:focus{border-color:var(--apiosk);box-shadow:0 0 0 3px var(--apiosk-soft)}
.result{font-size:12px;line-height:1.55}.result-grid{display:grid;gap:7px;margin-top:9px}.result-row{display:grid;grid-template-columns:minmax(90px,.38fr) minmax(0,1fr);gap:10px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 8%,transparent)}.result-row:last-child{border:0}.key{font-size:10px;opacity:.62;overflow-wrap:anywhere}.value{font-size:11px;overflow-wrap:anywhere;white-space:pre-wrap}details{margin-top:10px;font-size:10px;opacity:.7}.full-result{opacity:1}.full-result>summary{cursor:pointer;font-size:12px;font-weight:600;padding:8px 0}.full-result>summary:focus-visible{outline:2px solid var(--apiosk);outline-offset:3px}pre{max-height:240px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:10px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.typing{display:inline-flex;gap:3px;margin-left:5px;vertical-align:middle}.typing i{display:block;width:4px;height:4px;border-radius:50%;background:currentColor;animation:pulse 1.1s infinite ease-in-out}.typing i:nth-child(2){animation-delay:.16s}.typing i:nth-child(3){animation-delay:.32s}@keyframes pulse{0%,70%,100%{opacity:.25;transform:translateY(0)}35%{opacity:1;transform:translateY(-2px)}}
@media(max-width:480px){.request-section>.section-title{gap:8px}.request-price strong{font-size:14px}.request-price .price-note{max-width:140px}.plan-mode #sections>.request-section:first-child{padding:14px}.hero{display:block}.hero-status{align-items:flex-start;margin-top:11px}.amount{text-align:left}.source{grid-template-columns:32px minmax(0,1fr)}.source .count{grid-column:2}.balances{grid-template-columns:1fr}.result-row{grid-template-columns:1fr;gap:3px}}
@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
${V2_COMPACT_STYLE}
</style></head><body><main class="card hidden" id="card"><header class="shell" aria-labelledby="title">
<div class="hero"><div><h2 id="title"></h2><p id="subtitle" class="meta"></p></div><div class="hero-status">${V2_ACCOUNT_MARKUP}<span class="pill hidden" id="status-pill" aria-hidden="true"></span><div class="amount hidden" id="price"><b id="price-value"></b><span>maximum total</span></div></div></div>
</header><div id="sections"></div><div class="section hidden" id="feedback"><div id="feedback-text" class="notice" role="status" aria-live="polite"></div><div class="actions" id="feedback-actions"></div></div></main>
<script>${APIOSK_UI_BRIDGE}</script><script>
const byId=id=>document.getElementById(id),sections=byId('sections'),feedback=byId('feedback'),feedbackText=byId('feedback-text');let output=null,input={},busy=false,planSurface=null,pollTimer=null,watchUntil=0;const attempted=new Set(),announced=new Set();
${DISPLAY_TEXT}
const text=v=>v==null?'':String(v),pretty=v=>text(v).replace(/[._-]+/g,' ').replace(/\\b\\w/g,c=>c.toUpperCase());
function el(tag,className,value){const n=document.createElement(tag);if(className)n.className=className;if(value!=null)n.textContent=text(value);return n}
${formatDisplayMoney.toString()}
function money(atomic,currency='USD',ceiling=false){return formatDisplayMoney(atomic,currency,output?.context_view?.money_display,ceiling)}
function section(title,aside){const s=el('section','section'),h=el('div','section-title'),t=el('h3','',title);h.append(t);if(aside)h.append(aside&&aside.nodeType?aside:el('span','',aside));s.append(h);sections.append(s);return s}
function showFeedback(message,kind=''){feedback.classList.remove('hidden');feedbackText.textContent=message;feedbackText.className='notice '+kind;byId('feedback-actions').replaceChildren();window.apiosk.resize()}
${V2_CARD_ACCOUNT}
function safeLogo(url){try{const u=new URL(url);return u.protocol==='https:'&&${JSON.stringify(SOURCE_LOGO_ORIGINS)}.includes(u.origin)?u.href:null}catch{return null}}
function sourceLogo(source){const url=safeLogo(source&&source.logo_url);if(url){const img=el('img','logo');img.alt='';img.src=url;img.onerror=()=>img.replaceWith(fallbackLogo(source));return img}return fallbackLogo(source)}
function fallbackLogo(source){return el('span','logo fallback',text(source&&source.name||'A').trim().slice(0,1).toUpperCase()||'A')}
function invokeLabel(status){return({ready:'Ready',needs_input:'Input needed',needs_selection:'Choose one',requires_approval:'Approval needed',running:'Running',cancelled:'Cancelled',succeeded:'Completed',partial:'Partial result',unsupported:'Unavailable',state_conflict:'Updated',failed:'Failed'}[status]||pretty(status||'Ready'))}
function statusSubtitle(status){return({running:'Apiosk is working on your request.',cancelled:'No further source calls will be started. Saved results and charges remain available.',failed:'Your request could not be completed.',needs_input:'More information is needed to prepare your request.',needs_selection:'Choose the matching result to continue.',requires_approval:'Review the sources and maximum total before approving.',succeeded:'Your sourced result is ready.',partial:'Available results are ready. Some checks could not be completed.',unsupported:'This request cannot be completed with the available sources.'})[status]||'Your request is up to date.'}
function toolArgs(action,value){const args={action_id:action.action_id,state:output.state,idempotency_key:action.action_id,quote_ref:output.proposal&&output.proposal.quote_ref||null,input:value==null?null:value};return args}
async function callAction(action,value){if(busy||!output||!output.state)return;if(['select_entity','supply_input'].includes(action.kind))watchUntil=Date.now()+300000;busy=true;showFeedback(({select_entity:'Selecting the company…',supply_input:'Updating your request…',read_result:'Loading the saved result…',poll:'Checking status…',cancel:'Stopping remaining steps…'})[action.kind]||'Updating…');try{const next=await window.apiosk.callTool('apiosk_execute',toolArgs(action,value));acceptResponse(next)}catch(e){showFeedback(e&&e.message||'The request could not be completed.','error')}finally{busy=false}}
function acceptResponse(next){if(next?.state?.state_ref===output?.state?.state_ref&&Number(next.state.revision)<Number(output.state.revision))return;if(!next?.state){showFeedback(next?.message||(next?.errors||[]).map(e=>e.message).join(' ')||'The response was interrupted. Check status to recover your saved task.','error');return}render(next);void publishResult(next)}
async function publishResult(next){await window.apiosk.context(next).catch(()=>{});if(next.context_view?.worker_active||!['succeeded','partial'].includes(next.status)||next.result==null||!window.apiosk.can.autoFollowUp)return;const key=next.state.state_ref+':'+next.status;if(announced.has(key))return;announced.add(key);const sent=await window.apiosk.say(${JSON.stringify(V2_RESULT_READY_PROMPT)}).catch(()=>false);if(!sent)showFeedback('Your result is ready below.');}
function actionButton(action,label,primary=false,value=null){const b=el('button',primary?'primary':'',label||action.label);b.type='button';b.onclick=()=>callAction(action,value);return b}
${V2_CARD_SOURCES}
function sourceLine(source){const line=el('div','step-source'),logo=sourceLogo(source);logo.classList.add('mini');line.append(logo,el('span','',source.name||source.provider||'Apiosk source'));return line}
function sourceBadge(source){const badge=el('div','source-badge'),logo=sourceLogo(source);logo.classList.add('mini');badge.append(logo,el('span','',source.name||source.provider||'Source'));return badge}
function renderPlan(data){const p=data.proposal;if(!p)return;const formatted=money(p.max_total_atomic,p.currency,true),price=el('div','request-price');if(formatted)price.append(el('span','price-label','Maximum total'),el('strong','',formatted),el('span','price-note','From your Apiosk balance'));const s=section('Data request',price),list=el('div','steps');s.classList.add('request-section');planSurface=s;(p.steps||[]).forEach((step,i)=>{const d=(p.step_details||[])[i]||{},row=el('div','step'),copy=el('div'),source=d.source||{},title=el('div','step-title-line');title.append(el('div','step-title',d.title||pretty(step)),el('span','state '+text(d.status||'pending'),d.status||'pending'));copy.append(sourceLine(source),title);row.append(el('span','step-no',text(i+1)+'.'),copy);list.append(row)});s.append(list)}
${V2_CARD_CHOICES}
${V2_CARD_CLARIFICATION}
function renderInput(data){const action=(data.next_actions||[]).find(a=>a.kind==='supply_input');if(!action){renderClarification(data);return}const s=section('One detail is needed'),form=el('form','field'),field=el('input');field.required=true;field.autocomplete='off';field.placeholder='Enter the requested value';const b=el('button','primary','Continue');form.append(field,b);form.onsubmit=e=>{e.preventDefault();let value=field.value.trim();const type=action.input_schema&&action.input_schema.properties&&action.input_schema.properties.value&&action.input_schema.properties.value.type;if(type==='integer'||type==='number')value=Number(value);else if(type==='boolean')value=value==='true';callAction(action,{value})};s.append(form)}
function renderBilling(data){const b=data.billing;if(!b)return;if(data.context_view?.execution_mode==='server'&&!b.authorization_active&&!data.result&&!(b.executions||[]).length&&String(b.total_charged||'0')==='0')return;const available=money(b.balance_available,b.currency),charged=money(b.total_charged,b.currency);if(available==null&&charged==null)return;const s=section('Payment summary'),grid=el('div','balances');if(charged!=null){const box=el('div','balance');box.append(el('span','','Total charged · '+(b.workspace?.name||'Apiosk balance')),el('b','',charged));grid.append(box)}if(available!=null){const box=el('div','balance');box.append(el('span','','Available balance'),el('b','',available));grid.append(box)}s.append(grid)}
${V2_CARD_RESULT}
${V2_CARD_RESEARCH}
${V2_CARD_ACTIONS}
function renderErrors(data){const shown=new Set();const errors=(Array.isArray(data.errors)?data.errors:[]).filter(e=>{const message=e.message||e.code||'The request could not be completed.';if(shown.has(message))return false;shown.add(message);return true});if(!errors.length)return;const s=section('Needs attention');for(const e of errors)s.append(el('div','notice error',e.message||e.code||'The request could not be completed.'))}
function render(data){if(!data||typeof data!=='object')return;output=data;planSurface=null;if(pollTimer){clearTimeout(pollTimer);pollTimer=null}const card=byId('card');card.classList.remove('hidden');data.proposal?card.classList.add('plan-mode'):card.classList.remove('plan-mode');sections.replaceChildren();feedback.classList.add('hidden');byId('price').classList.add('hidden');renderAccount(data);const status=Array.isArray(data.sources)?'ready':data.status||'ready';byId('status-pill').textContent=invokeLabel(status);if(Array.isArray(data.sources))renderSources(data);else{byId('title').textContent=invokeLabel(data.status);byId('subtitle').textContent=statusSubtitle(data.status);renderPlan(data);renderChoices(data);renderInput(data);renderResult(data);renderActions(data);renderBilling(data);if(data.context_view?.money_display?.fallback_reason)section('Currency').append(el('p','notice','Display currency conversion is unavailable. Amounts are shown in USD.'));renderErrors(data)}window.apiosk.resize()}
${V2_CARD_EVENTS}
${V2_CARD_COMPACT}
const recoveredCards=new Set();window.apiosk.onInput&&window.apiosk.onInput(value=>{input=value||{}});window.apiosk.onData(data=>{render(data);const ref=data?.state?.state_ref;if(ref&&!recoveredCards.has(ref)){recoveredCards.add(ref);setTimeout(()=>{if(output?.state?.state_ref===ref&&!busy)void refreshTask(false)},100)}});
</script></body></html>`;

export function gatewayV2CardHtml(gatewayUrl = "https://api.apiosk.com") {
  return APIO_V2_CARD_HTML_TEMPLATE.replaceAll("__APIOSK_GATEWAY_ORIGIN__", new URL(gatewayUrl).origin);
}

export const APIO_V2_CARD_HTML = gatewayV2CardHtml();
