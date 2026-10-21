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
  byId('title').textContent='Apiosk · Bedrijfsmonitor';byId('subtitle').textContent='';
  if(data.view==='company_check_history'){
    if(data.latest){renderCompanyCheck(data.latest);companyDetails(section('Controlehistorie'),'Uitvoeringen',data.runs)}
    else {companyText(section('Bedrijvenlijst'),'p','De bedrijvenlijst is opgeslagen. Er is nog geen afgeronde controle.');companyDetails(section('Uitvoeringen'),'Historie',data.runs)}
    window.apiosk.resize();return;
  }
  if(data.view==='company_check_acknowledgement'){byId('status-pill').textContent='Opgeslagen';companyText(section('Meldingen'),'p','De verzendbevestiging van de mailkoppeling is opgeslagen. Deze signalen worden niet opnieuw gemaild.');window.apiosk.resize();return}
  if(data.view==='company_check_delivery'){byId('status-pill').textContent=data.status==='suppressed'?'Geen e-mail nodig':data.status==='sent'?'Verzending bevestigd':'E-mailoverdracht';companyText(section('E-mail'),'p',data.status==='suppressed'?'Er zijn geen nieuwe signalen om te mailen.':data.dispatch_allowed?'Het bericht staat klaar voor de mailkoppeling. Het is nog niet verzonden.':'Controleer de eerdere verzending voordat je verdergaat. Niet opnieuw versturen.');if(data.payload)companyDetails(section('Bericht'),'Opgeslagen e-mail',data.payload);window.apiosk.resize();return}
  if(data.view==='company_check_evidence'){byId('status-pill').textContent='Opgeslagen bronbewijs';companyDetails(section('Bronbewijs'),'Oorspronkelijk bronresultaat',data.source);window.apiosk.resize();return}
  if(data.view==='company_check_pending'){byId('status-pill').textContent='In voorbereiding';companyText(section('Voortgang'),'p',data.message);window.apiosk.resize();return}
  byId('status-pill').textContent=data.status==='completed'?'Uitgevoerd':'Onvolledige dekking';
  byId('subtitle').textContent=data.checked_at?'Gecontroleerd op '+data.checked_at:'';
  const summary=section('Overzicht'),grid=el('div','balances');
  for(const [label,value] of [['Bedrijven',data.company_count],['Nieuwe signalen',data.new_signal_count],['Bronresultaten',data.source_count]]){const box=el('div','balance');box.append(el('span','',label),el('b','',value));grid.append(box)}summary.append(grid);
  for(const signal of data.new_signals||[]){
    const s=section((signal.company_name||signal.kvk_number)+' — Handmatige beoordeling vereist');
    
    companyText(s,'p','KvK '+signal.kvk_number,'meta');
    companyText(s,'p',signal.message);
    if(signal.carried_forward)companyText(s,'p','Eerder waargenomen, nog niet per e-mail bevestigd. Zie de oorspronkelijke brondatum.','meta');
    companyText(s,'p',signal.change==='first_observation'?'Eerste waarneming; er is nog geen vorige controle.':'Niet eerder gemeld door deze controle.');
    if(signal.previous!=null)companyDetails(s,'Verschil met vorige controle',{vorige:signal.previous,huidige:signal.current});
    if(signal.url){const link=el('a','',signal.url);try{const u=new URL(signal.url);if(['https:','http:'].includes(u.protocol)){link.href=u.href;link.target='_blank';link.rel='noopener noreferrer';s.append(link)}}catch{}}
    if(signal.published_at)companyText(s,'p','Gepubliceerd: '+signal.published_at,'meta');
    companyDetails(s,'Bronbewijs en controletijdstip',signal.evidence);
  }
  if(!(data.new_signals||[]).length)companyText(section('Signalen'),'p','Geen nieuwe relevante signalen in de beschikbare brongegevens. Controleer ook de dekking hieronder.');
  const gaps=(data.coverage||[]).filter(c=>c.status!=='checked');
  if(gaps.length){const s=section('Ontbrekende dekking');for(const g of gaps)companyText(s,'p','KvK '+g.kvk_number+': '+g.message,'notice')}
  const cost=section('Werkelijke kosten per uitvoering');
  if(data.billing?.total_charged!=null){const amount=money(data.billing.total_charged,data.billing.currency);if(amount)companyText(cost,'p','Totaal: '+amount)}
  for(const source of (data.sources||[]).filter(s=>!s.historical)){const amount=money(source.charged_atomic,source.currency);companyText(cost,'p',(source.source?.name||source.source?.api_slug||'Bron')+': '+(amount||'Kosten niet gespecificeerd'))}
  const notices=(data.sources||[]).map(s=>s.source);if(sourceUsageNotices(notices).length)appendSourceUsageNotices(section('Broninformatie'),notices);
  companyDetails(section('Bronnen en details'),'Controledekking en bewaarde bronverwijzingen',{coverage:data.coverage,sources:data.sources});
  const limitations=section('Toelichting');for(const note of data.limitations||[])companyText(limitations,'p',note,'meta');
  companyText(limitations,'p','Claude of ChatGPT plant de herhaling en gebruikt de gekoppelde maildienst. Deze kaart bevestigt geen planning of verzending.','meta');
  window.apiosk.resize();
}
async function collectCompanyCheck(){
  if(companyCollecting||!companyCheckContext)return;
  const key=companyCheckContext.check_id+':'+companyCheckContext.occurrence;if(companyCollected===key)return;
  companyCollecting=true;
  try{const result=await window.apiosk.callTool('apiosk_company_check_result',{check_id:companyCheckContext.check_id,occurrence:companyCheckContext.occurrence});
    if(result?.view==='company_check'){companyCollected=key;renderCompanyCheck(result);await window.apiosk.context(result).catch(()=>{});if(window.apiosk.can.autoFollowUp)await window.apiosk.say('The saved company check is ready. Read apiosk_company_check_result for check_id '+companyCheckContext.check_id+' and occurrence '+companyCheckContext.occurrence+'. Use only new signals for the requested email. Prepare it with apiosk_company_check_email and send only if dispatch_allowed=true. Confirm only after a successful email connector receipt. Reading this card is not delivery. Do not start another purchase.').catch(()=>{})}
    else if(result?.error_code)showFeedback(result.message,'error');
  }catch{showFeedback('De opgeslagen vergelijking kon nog niet worden geladen. Gebruik de resultaattool opnieuw; een nieuwe aankoop is niet nodig.','error')}
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
