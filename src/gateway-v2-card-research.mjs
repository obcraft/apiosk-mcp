import { V2_CARD_CBS } from './gateway-v2-card-cbs.mjs';
import { V2_CARD_VERDICT } from './gateway-v2-card-verdict.mjs';
import { V2_CARD_ANSWER } from './gateway-v2-card-answer.mjs';
// All source values remain text nodes. This layer has no purchasing authority.
export const V2_CARD_RESEARCH = `
${V2_CARD_CBS}
${V2_CARD_VERDICT}
${V2_CARD_ANSWER}
const renderSingleResult=renderResult;
const sourceDisclosureState=new Map();
renderResult=function(data){
 const results=data.context_view?.results?.length?data.context_view.results:data.result==null?[]:[data.result];
 const verdict=supplierVerdictView(supplierVerdictAnalysis(data)),cbs=verdict?null:cbsAnnualView(data,results);const surface=verdict?renderSupplierVerdict(verdict):cbs?renderCbsAnnual(cbs):renderResearchAnswer(data,results);
 let disclosure=null;
 if(results.length||data.context_view?.analysis){
  const sourceCount=new Set(results.map(result=>result.source?.provider||result.source?.name||'Source')).size;
  const s=section('Sources and details');s.classList.add('source-results-section');
  disclosure=el('details','source-results-toggle');disclosure.append(el('summary','','Sources and details · '+sourceCount+(sourceCount===1?' source':' sources')+' · '+results.length+(results.length===1?' result':' results')));
  const key=data.state?.state_ref;disclosure.open=key?sourceDisclosureState.get(key)===true:false;
  disclosure.ontoggle=()=>{if(key){sourceDisclosureState.set(key,disclosure.open);if(sourceDisclosureState.size>20)sourceDisclosureState.delete(sourceDisclosureState.keys().next().value)}window.apiosk.resize()};
  const list=el('div','source-results-list');disclosure.append(list);s.append(disclosure);
  for(const result of results){if(cbs?.records.includes(result))continue;renderSingleResult({...data,result});const node=sections.lastElementChild,heading=node?.querySelector('h3');if(heading&&result?.subject?.label)heading.textContent='Result · '+formatDisplayNarrative(result.subject.label,result);if(node)list.append(node)}
 }
 if(surface?.title){byId('title').textContent=surface.title;byId('subtitle').textContent=surface.subtitle}
 const report=data.context_view?.report,analysis=data.context_view?.analysis;
 if(report||analysis){const s=surface?.section||el('section','section result-extras');if(!surface)sections.append(s);const links=surface?.links||el('div','result-links');if(!surface)s.append(links);
  if(report?.format==='pdf'&&typeof report.url==='string'&&report.url.startsWith('https://')){const download=el('button','text-action','Download PDF');download.onclick=()=>window.apiosk.openLink(report.url);links.append(download)}
  if(analysis&&!verdict){const details=disclosure||surface?.details||el('details','compact-details result-details');if(!disclosure&&!surface){details.append(el('summary','','Details'));details.ontoggle=()=>window.apiosk.resize();s.append(details)}const notes=el('div','analysis-notes');notes.append(el('p','key',cbs?'Toelichting':'Full analysis and limitations'));
   for(const observation of analysis.observations||[]){notes.append(el('p','result',formatDisplayNarrative(observation.text,data)));const evidence=el('details','evidence-details');evidence.append(el('summary','',cbs?'Onderbouwing':'Source evidence'));for(const item of observation.evidence||[])evidence.append(el('p','value',formatDisplayNarrative(item.subject?.label||item.source?.name||'Source',data)+': '+formatSourceValue(item.value,item.field||item.pointer,null,data)+' · '+item.pointer));notes.append(evidence)}
   for(const limitation of analysis.limitations||[])notes.append(el('p','notice',formatDisplayNarrative(limitation,data)));details.append(notes)
  }
 }
 if(data.context_view?.analyzing)section('Analysis').append(el('p','notice','Analyzing the saved source results…'));
 const cooldown=data.context_view?.cooldown;
 if(cooldown){const kvk=/KVK/.test(cooldown.message||''),s=section(kvk?'Waiting for KVK':'Waiting for the source'),timer=el('p','notice');s.append(el('p','meta',cooldown.message),timer);const tick=()=>{const seconds=Math.max(0,Math.ceil((Date.parse(cooldown.until)-Date.now())/1000));timer.textContent=seconds?(kvk?'Next annual report in ':'Checking again in ')+Math.floor(seconds/60)+':'+String(seconds%60).padStart(2,'0'):'Continuing the approved request…'};tick();const interval=setInterval(()=>{if(!timer.isConnected){clearInterval(interval);return}tick()},1000);if(data.billing?.authorization_active&&data.billing.quote_ref===data.proposal?.quote_ref)watchUntil=Math.max(watchUntil,Date.parse(cooldown.until)+300000)}
};
const renderOriginalPlan=renderPlan;
renderPlan=function(data){renderOriginalPlan(data);if(!planSurface)return;const notices=data.context_view?.coverage_notices;if(Array.isArray(notices)&&notices.length){const coverage=el('div','plan-coverage');coverage.append(el('p','key','Scope of this check'));for(const notice of notices.slice(0,8)){if(typeof notice==='string')coverage.append(el('p','notice',notice))}planSurface.append(coverage)}const rows=planSurface.querySelectorAll('.step');for(const [index,row] of rows.entries()){const detail=data.proposal?.step_details?.[index];const copy=row.lastElementChild;if(detail?.subject)copy.prepend(el('p','step-title',formatDisplayNarrative(detail.subject,data)));if(detail?.error?.message)copy.append(el('p','notice error',detail.error.message))}};
`;
