import { V2_CARD_CHOICES } from './gateway-v2-card-choices.mjs';
import { DISPLAY_TEXT } from './display-text.mjs';
import { V2_CARD_CLARIFICATION } from "./gateway-v2-card-clarification.mjs";
import { formatDisplayMoney } from "./display-money.mjs";
import { V2_CARD_EVENTS } from "./gateway-v2-card-events.mjs";
import { V2_CARD_RESULT } from "./gateway-v2-card-result.mjs";
import { V2_CARD_RESEARCH } from "./gateway-v2-card-research.mjs";
import { V2_RESULT_READY_PROMPT, V2_SOURCES_PRESENTATION } from "./result-presentation.mjs";
import { V2_CARD_ACTIONS } from "./gateway-v2-card-actions.mjs";
import { V2_ACCOUNT_MARKUP, V2_CARD_ACCOUNT } from "./gateway-v2-card-account.mjs";
import { V2_CARD_SOURCES } from "./gateway-v2-card-sources.mjs";
import { V2_CARD_SEARCH } from "./gateway-v2-card-search.mjs";
import { V2_CARD_COMPACT } from "./gateway-v2-card-compact.mjs";
import { V2_CARD_STYLE } from "./gateway-v2-card-style.mjs";
import { V2_SOURCE_USAGE_NOTICE } from "./source-usage-notice.mjs";
import { APIOSK_UI_BRIDGE, APIOSK_UI_STYLE, uiResourceMeta } from "./ui-bridge.mjs";

export const APIO_V2_CARD_URI="ui://apiosk/gateway-v2-card-v58.html";
export const APIO_V2_CHATGPT_CARD_URI="ui://apiosk/gateway-v2-card-v22-chatgpt.html";
export const APIO_V2_MODERN_CARD_URIS = [APIO_V2_CARD_URI, "ui://apiosk/gateway-v2-card-v57.html", "ui://apiosk/gateway-v2-card-v56.html", "ui://apiosk/gateway-v2-card-v55.html", "ui://apiosk/gateway-v2-card-v54.html"];
export const APIO_V2_CARD_LEGACY_URIS = [...Array.from({length:57},(_,i)=>`ui://apiosk/gateway-v2-card-v${i+1}.html`), ...Array.from({length:11},(_,i)=>`ui://apiosk/gateway-v2-card-v${i+11}-chatgpt.html`)];

const SOURCE_LOGO_ORIGINS = ["https://mcp.apiosk.com", "https://api.apiosk.com", "https://overheid.io", "https://agentbodega.store", "https://pulse.theaslangroupllc.com", "https://www.browserbase.com", "https://www.cityfalcon.ai", "https://crowdpull.click", "https://eodhd.com", "https://exa.ai", "https://www.gleif.org", "https://www.linkup.so", "https://stableenrich.dev", "https://www.tavily.com", "https://x402.webbersites.com"];

export function gatewayV2CardMeta(gatewayUrl="https://api.apiosk.com") {
  const gatewayOrigin = new URL(gatewayUrl).origin;
  const meta = uiResourceMeta(
    "Shows Apiosk plan, price, approval, progress and an answer-first result. Source records are collapsed under Sources and details. For verification questions, briefly state the supported conclusion and material unknowns, not just that data was fetched. Do not equate active registration with onboarding clearance. " + V2_SOURCES_PRESENTATION
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
${V2_CARD_STYLE}
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
${V2_CARD_SEARCH}
function sourceLine(source){const line=el('div','step-source'),logo=sourceLogo(source);logo.classList.add('mini');line.append(logo,el('span','',source.name||source.provider||'Apiosk source'));return line}
function sourceBadge(source){const badge=el('div','source-badge'),logo=sourceLogo(source);logo.classList.add('mini');badge.append(logo,el('span','',source.name||source.provider||'Source'));return badge}
${V2_SOURCE_USAGE_NOTICE}
function renderPlan(data){const p=data.proposal;if(!p)return;const formatted=money(p.max_total_atomic,p.currency,true),price=el('div','request-price');if(formatted)price.append(el('span','price-label','Maximum total'),el('strong','',formatted),el('span','price-note','From your Apiosk balance'));const s=section('Data request',price),list=el('div','steps');s.classList.add('request-section');planSurface=s;(p.steps||[]).forEach((step,i)=>{const d=(p.step_details||[])[i]||{},row=el('div','step'),copy=el('div'),source=d.source||{},title=el('div','step-title-line');title.append(el('div','step-title',d.title||pretty(step)),el('span','state '+text(d.status||'pending'),d.status||'pending'));copy.append(sourceLine(source),title);row.append(el('span','step-no',text(i+1)+'.'),copy);list.append(row)});s.append(list)}
${V2_CARD_CHOICES}
${V2_CARD_CLARIFICATION}
function renderBilling(data){const b=data.billing;if(!b)return;if(data.context_view?.execution_mode==='server'&&!b.authorization_active&&!data.result&&!(b.executions||[]).length&&String(b.total_charged||'0')==='0')return;const available=money(b.balance_available,b.currency),charged=money(b.total_charged,b.currency);if(available==null&&charged==null)return;const s=section('Payment summary'),grid=el('div','balances');if(charged!=null){const box=el('div','balance');box.append(el('span','','Total charged · '+(b.workspace?.name||'Apiosk balance')),el('b','',charged));grid.append(box)}if(available!=null){const box=el('div','balance');box.append(el('span','','Available balance'),el('b','',available));grid.append(box)}s.append(grid)}
${V2_CARD_RESULT}
${V2_CARD_RESEARCH}
${V2_CARD_ACTIONS}
function renderErrors(data){const shown=new Set();const errors=(Array.isArray(data.errors)?data.errors:[]).filter(e=>{const message=e.message||e.code||'The request could not be completed.';if(shown.has(message))return false;shown.add(message);return true});if(!errors.length)return;const s=section('Needs attention');for(const e of errors)s.append(el('div','notice error',e.message||e.code||'The request could not be completed.'))}
function render(data){if(!data||typeof data!=='object')return;output=data;planSurface=null;if(pollTimer){clearTimeout(pollTimer);pollTimer=null}const card=byId('card');card.classList.remove('hidden');data.proposal?card.classList.add('plan-mode'):card.classList.remove('plan-mode');sections.replaceChildren();feedback.classList.add('hidden');byId('price').classList.add('hidden');renderAccount(data);const status=Array.isArray(data.sources)?'ready':data.status||'ready';byId('status-pill').textContent=invokeLabel(status);if(data.view==='source_search')renderSourceSearch(data);else if(Array.isArray(data.sources))renderSources(data);else{byId('title').textContent=invokeLabel(data.status);byId('subtitle').textContent=statusSubtitle(data.status);renderPlan(data);renderChoices(data);renderInput(data);renderResult(data);renderActions(data);renderBilling(data);if(data.context_view?.money_display?.fallback_reason)section('Currency').append(el('p','notice','Display currency conversion is unavailable. Amounts are shown in USD.'));renderErrors(data)}window.apiosk.resize()}
${V2_CARD_EVENTS}
${V2_CARD_COMPACT}
const recoveredCards=new Set();window.apiosk.onInput&&window.apiosk.onInput(value=>{input=value||{}});window.apiosk.onData(data=>{render(data);const ref=data?.state?.state_ref;if(ref&&!recoveredCards.has(ref)){recoveredCards.add(ref);setTimeout(()=>{if(output?.state?.state_ref===ref&&!busy)void refreshTask(false)},100)}});
</script></body></html>`;

export function gatewayV2CardHtml(gatewayUrl="https://api.apiosk.com") {
  return APIO_V2_CARD_HTML_TEMPLATE.replaceAll("__APIOSK_GATEWAY_ORIGIN__", new URL(gatewayUrl).origin);
}

export const APIO_V2_CARD_HTML = gatewayV2CardHtml();
