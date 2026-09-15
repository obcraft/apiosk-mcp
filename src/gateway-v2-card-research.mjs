import { V2_CARD_CBS } from './gateway-v2-card-cbs.mjs';
import { V2_CARD_VERDICT } from './gateway-v2-card-verdict.mjs';
// All source values remain text nodes. This layer has no purchasing authority.
export const V2_CARD_RESEARCH = `
${V2_CARD_CBS}
${V2_CARD_VERDICT}
const renderSingleResult=renderResult;
renderResult=function(data){
 const results=data.context_view?.results?.length?data.context_view.results:data.result==null?[]:[data.result];
 const verdict=supplierVerdictView(supplierVerdictAnalysis(data)),cbs=verdict?null:cbsAnnualView(data,results);const surface=verdict?renderSupplierVerdict(verdict):cbs?renderCbsAnnual(cbs):null;
 for(const result of results){if(cbs?.records.includes(result))continue;renderSingleResult({...data,result});const heading=sections.lastElementChild?.querySelector('h3');if(heading&&result?.subject?.label)heading.textContent='Result · '+result.subject.label}
 if(verdict){byId('title').textContent=surface.title;byId('subtitle').textContent=surface.subtitle}
 const report=data.context_view?.report,analysis=data.context_view?.analysis;
 if(report||analysis){const s=surface?.section||el('section','section result-extras');if(!surface)sections.append(s);const links=surface?.links||el('div','result-links');if(!surface)s.append(links);
  if(report?.format==='pdf'&&typeof report.url==='string'&&report.url.startsWith('https://')){const download=el('button','text-action','Download PDF');download.onclick=()=>window.apiosk.openLink(report.url);links.append(download)}
  if(analysis&&!verdict){const details=surface?.details||el('details','compact-details result-details');if(!surface){details.append(el('summary','','Details'));details.ontoggle=()=>window.apiosk.resize();s.append(details)}const notes=el('div','analysis-notes');notes.append(el('p','key',cbs?'Toelichting':'Analysis'));
   for(const observation of analysis.observations||[]){notes.append(el('p','result',observation.text));const evidence=el('details','evidence-details');evidence.append(el('summary','',cbs?'Onderbouwing':'Source evidence'));for(const item of observation.evidence||[])evidence.append(el('p','value',(item.subject?.label||item.source?.name||'Source')+': '+text(item.value)+' · '+item.pointer));notes.append(evidence)}
   for(const limitation of analysis.limitations||[])(data.status==='partial'?s:notes).append(el('p','notice',limitation));details.append(notes)
  }
 }
 if(data.context_view?.analyzing)section('Analysis').append(el('p','notice','Analyzing the saved source results…'));
 const cooldown=data.context_view?.cooldown;
 if(cooldown){const kvk=/KVK/.test(cooldown.message||''),s=section(kvk?'Waiting for KVK':'Waiting for the source'),timer=el('p','notice');s.append(el('p','meta',cooldown.message),timer);const tick=()=>{const seconds=Math.max(0,Math.ceil((Date.parse(cooldown.until)-Date.now())/1000));timer.textContent=seconds?(kvk?'Next annual report in ':'Checking again in ')+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'Continuing the approved request…'};tick();const interval=setInterval(()=>{if(!timer.isConnected){clearInterval(interval);return}tick()},1000);if(data.billing?.authorization_active&&data.billing.quote_ref===data.proposal?.quote_ref)watchUntil=Math.max(watchUntil,Date.parse(cooldown.until)+300000)}
};
const renderOriginalPlan=renderPlan;
renderPlan=function(data){renderOriginalPlan(data);if(!planSurface)return;const rows=planSurface.querySelectorAll('.step');for(const [index,row] of rows.entries()){const detail=data.proposal?.step_details?.[index];const copy=row.lastElementChild;if(detail?.subject)copy.prepend(el('p','step-title',detail.subject));if(detail?.error?.message)copy.append(el('p','notice error',detail.error.message))}};
`;
