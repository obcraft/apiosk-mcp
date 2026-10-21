import { gatewayV2CardHtml, gatewayV2CardMeta } from './gateway-v2-card.mjs';

// Distinct resource/cache identities: the frozen Ask card is never changed.
export const COMPANY_CARD_URI = 'ui://apiosk/company-check-v1.html';
export const COMPANY_CHATGPT_CARD_URI = 'ui://apiosk/company-check-v1-chatgpt.html';
export function companyCheckCardMeta(url) {
  const meta = gatewayV2CardMeta(url);
  meta['openai/widgetDescription'] = 'Source-backed company checks: exact company identity, new signals, coverage gaps, evidence, comparison and actual costs. A partial check is never displayed as clearance. The host owns scheduling.';
  return meta;
}
const extension = `
let companyCheckContext=null,companyCollecting=false,companyCollected=null;
function companyText(parent,tag,value,className=''){const n=el(tag,className,value);parent.append(n);return n}
function companyDetails(parent,title,value){const d=el('details'),summary=el('summary','',title);d.append(summary,el('pre','',JSON.stringify(value,null,2)));parent.append(d)}
function renderCompanyCheck(data){
  output=data;byId('card').classList.remove('hidden','plan-mode');sections.replaceChildren();feedback.classList.add('hidden');byId('price').classList.add('hidden');
  byId('title').textContent='Apiosk · Company monitor';byId('subtitle').textContent='';
  if(data.view==='company_check_history'){
    if(data.latest){renderCompanyCheck(data.latest);companyDetails(section('Check history'),'Runs',data.runs)}
    else {companyText(section('Company list'),'p','The company list is saved. No check has completed yet.');companyDetails(section('Runs'),'History',data.runs)}
    window.apiosk.resize();return;
  }
  if(data.view==='company_check_acknowledgement'){byId('status-pill').textContent='Saved';companyText(section('Notifications'),'p','The email connector receipt is saved. These signals will not be emailed again.');window.apiosk.resize();return}
  if(data.view==='company_check_delivery'){byId('status-pill').textContent=data.status==='suppressed'?'No email needed':data.status==='sent'?'Delivery confirmed':'Email handoff';companyText(section('Email'),'p',data.status==='suppressed'?'There are no new signals to email.':data.dispatch_allowed?'The message is ready for the email connector. It has not been sent yet.':'Check the earlier delivery before continuing. Do not send it again.');if(data.payload)companyDetails(section('Message'),'Saved email',data.payload);window.apiosk.resize();return}
  if(data.view==='company_check_evidence'){byId('status-pill').textContent='Saved source evidence';companyDetails(section('Source evidence'),'Original source result',data.source);window.apiosk.resize();return}
  if(data.view==='company_check_pending'){byId('status-pill').textContent='Preparing';companyText(section('Progress'),'p',data.message);window.apiosk.resize();return}
  byId('status-pill').textContent=data.status==='completed'?'Completed':'Incomplete coverage';
  byId('subtitle').textContent=data.checked_at?'Checked at '+data.checked_at:'';
  const summary=section('Overview'),grid=el('div','balances');
  for(const [label,value] of [['Companies',data.company_count],['New signals',data.new_signal_count],['Source results',data.source_count]]){const box=el('div','balance');box.append(el('span','',label),el('b','',value));grid.append(box)}summary.append(grid);
  for(const signal of data.new_signals||[]){
    const s=section((signal.company_name||signal.kvk_number)+' — Manual review required');
    
    companyText(s,'p','KVK '+signal.kvk_number,'meta');
    companyText(s,'p',signal.message);
    if(signal.carried_forward)companyText(s,'p','Previously observed, not yet confirmed by email. See the original source date.','meta');
    companyText(s,'p',signal.change==='first_observation'?'First observation; there is no previous check yet.':'Not previously reported by this check.');
    if(signal.previous!=null)companyDetails(s,'Difference from the previous check',{previous:signal.previous,current:signal.current});
    if(signal.url){const link=el('a','',signal.url);try{const u=new URL(signal.url);if(['https:','http:'].includes(u.protocol)){link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';s.append(link)}}catch{}}
    if(signal.published_at)companyText(s,'p','Published: '+signal.published_at,'meta');
    companyDetails(s,'Source evidence and check time',signal.evidence);
  }
  if(!(data.new_signals||[]).length)companyText(section('Signals'),'p','No new relevant signals in the available source data. Also check the coverage below.');
  const gaps=(data.coverage||[]).filter(c=>c.status!=='checked');
  if(gaps.length){const s=section('Missing coverage');for(const g of gaps)companyText(s,'p','KVK '+g.kvk_number+': '+g.message,'notice')}
  const cost=section('Actual cost per run');
  if(data.billing?.total_charged!=null){const amount=money(data.billing.total_charged,data.billing.currency);if(amount)companyText(cost,'p','Total: '+amount)}
  for(const source of (data.sources||[]).filter(s=>!s.historical)){const amount=money(source.charged_atomic,source.currency);companyText(cost,'p',(source.source?.name||source.source?.api_slug||'Source')+': '+(amount||'Cost not itemized'))}
  const notices=(data.sources||[]).map(s=>s.source);if(sourceUsageNotices(notices).length)appendSourceUsageNotices(section('Source information'),notices);
  companyDetails(section('Sources and details'),'Check coverage and saved source references',{coverage:data.coverage,sources:data.sources});
  const limitations=section('Notes');for(const note of data.limitations||[])companyText(limitations,'p',note,'meta');
  companyText(limitations,'p','Claude or ChatGPT schedules the repeat and uses the connected email service. This card confirms neither a schedule nor a delivery.','meta');
  window.apiosk.resize();
}
async function collectCompanyCheck(){
  if(companyCollecting||!companyCheckContext)return;
  const key=companyCheckContext.check_id+':'+companyCheckContext.occurrence;if(companyCollected===key)return;
  companyCollecting=true;
  try{const result=await window.apiosk.callTool('apiosk_company_check_result',{check_id:companyCheckContext.check_id,occurrence:companyCheckContext.occurrence});
    if(result?.view==='company_check'){companyCollected=key;renderCompanyCheck(result);await window.apiosk.context(result).catch(()=>{});if(window.apiosk.can.autoFollowUp)await window.apiosk.say('The saved company check is ready. Read apiosk_company_check_result for check_id '+companyCheckContext.check_id+' and occurrence '+companyCheckContext.occurrence+'. Use only new signals for the requested email. Prepare it with apiosk_company_check_email and send only if dispatch_allowed=true. Confirm only after a successful email connector receipt. Reading this card is not delivery. Do not start another purchase.').catch(()=>{})}
    else if(result?.error_code)showFeedback(result.message,'error');
  }catch{showFeedback('The saved comparison could not be loaded yet. Use the result tool again; no new purchase is needed.','error')}
  finally{companyCollecting=false}
}
`;

export function companyCheckCardHtml(url) {
  const base = gatewayV2CardHtml(url);
  const marker = 'function render(data){';
  if (!base.includes(marker)) throw new Error('The shared task renderer changed; review the company-check card integration.');
  return base.replace('async function publishResult(next){','async function publishResult(next){if(companyCheckContext)return;').replace(marker, extension + marker + `
    if(data?.view?.startsWith('company_check')){renderCompanyCheck(data);return}
    if(data?.context_view?.company_check)companyCheckContext=data.context_view.company_check;
    if(companyCheckContext&&!data?.context_view?.worker_active&&['succeeded','partial','failed','cancelled','unsupported'].includes(data?.status))queueMicrotask(collectCompanyCheck);
  `);
}
