import { V2_CARD_CBS } from './gateway-v2-card-cbs.mjs';
// All source values remain text nodes. This layer has no purchasing authority.
export const V2_CARD_RESEARCH = `
${V2_CARD_CBS}
const renderSingleResult=renderResult;
renderResult=function(data){
 const results=data.context_view?.results?.length?data.context_view.results:data.result==null?[]:[data.result];
 const cbs=cbsAnnualView(data,results);if(cbs)renderCbsAnnual(cbs);
 for(const result of results){if(cbs?.records.includes(result))continue;renderSingleResult({...data,result});const heading=sections.lastElementChild?.querySelector('h3');if(heading&&result?.subject?.label)heading.textContent='Result · '+result.subject.label}
 const report=data.context_view?.report;if(report?.format==='pdf'&&typeof report.url==='string'&&report.url.startsWith('https://')){const s=section('Research report');const download=el('button','quiet','Download research and analysis (PDF)');download.onclick=()=>window.apiosk.openLink(report.url);s.append(download)}
 const analysis=data.context_view?.analysis;
 if(analysis){const s=section('Analysis');for(const observation of analysis.observations||[]){s.append(el('p','result',observation.text));const details=el('details');details.append(el('summary','','Source evidence'));for(const evidence of observation.evidence||[])details.append(el('p','value',(evidence.subject?.label||evidence.source?.name||'Source')+': '+text(evidence.value)+' · '+evidence.pointer));s.append(details)}for(const limitation of analysis.limitations||[])s.append(el('p','notice',limitation))}
 if(data.context_view?.analyzing)section('Analysis').append(el('p','notice','Analyzing the saved source results…'));
 const cooldown=data.context_view?.cooldown;
 if(cooldown){const kvk=/KVK/.test(cooldown.message||''),s=section(kvk?'Waiting for KVK':'Waiting for the source'),timer=el('p','notice');s.append(el('p','meta',cooldown.message),timer);const tick=()=>{const seconds=Math.max(0,Math.ceil((Date.parse(cooldown.until)-Date.now())/1000));timer.textContent=seconds?(kvk?'Next annual report in ':'Checking again in ')+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'Continuing the approved request…'};tick();const interval=setInterval(()=>{if(!timer.isConnected){clearInterval(interval);return}tick()},1000);if(data.billing?.authorization_active&&data.billing.quote_ref===data.proposal?.quote_ref)watchUntil=Math.max(watchUntil,Date.parse(cooldown.until)+300000)}
};
const renderOriginalPlan=renderPlan;
renderPlan=function(data){renderOriginalPlan(data);if(!planSurface)return;const rows=planSurface.querySelectorAll('.step');for(const [index,row] of rows.entries()){const detail=data.proposal?.step_details?.[index];const copy=row.lastElementChild;if(detail?.subject)copy.prepend(el('p','step-title',detail.subject));if(detail?.error?.message)copy.append(el('p','notice error',detail.error.message))}};
`;
