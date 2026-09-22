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
function sourceGroupKey(result){const source=result?.source||{};return source.provider||source.name||source.url||'Source'}
function sourceMetric(group,names){for(const result of group){const body=displayData(result?.data!=null?result.data:result);if(!body||typeof body!=='object'||Array.isArray(body))continue;for(const name of names){const value=body[name];if(value!=null&&['string','number','boolean'].includes(typeof value))return value}}return null}
function sourceResultCount(group){const explicit=sourceMetric(group,['total_results','totalResults','total_count','totalCount','number_of_results','numberOfResults']);if(explicit!=null)return explicit;let count=0,found=false;for(const result of group){const body=displayData(result?.data!=null?result.data:result);for(const name of ['results','items','resultaten'])if(Array.isArray(body?.[name])){count+=body[name].length;found=true}if(body?.responses&&typeof body.responses==='object'){for(const response of Object.values(body.responses)){const total=response?.total?.value;if(typeof total==='number'){count+=total;found=true}else if(Array.isArray(response?.results)){count+=response.results.length;found=true}}}}return found?count:null}
function sourceSummaryCell(label,value){const cell=el('span','source-result-cell');cell.append(el('span','source-result-label',label),el('span','source-result-value',value==null||value===''?'—':value));return cell}
function renderSourceGroup(data,group){const source=group[0]?.source||{},details=el('details','source-result-group'),summary=el('summary','source-result-summary'),logo=sourceLogo(source);logo.classList.add('mini');summary.append(logo,el('span','source-result-name',source.name||source.provider||'Source'),sourceSummaryCell('Kind',sourceMetric(group,['kind'])),sourceSummaryCell('Results',sourceResultCount(group)),sourceSummaryCell('Items per page',sourceMetric(group,['items_per_page','itemsPerPage','page_size','pageSize'])),sourceSummaryCell('Page number',sourceMetric(group,['page_number','pageNumber','page'])),sourceSummaryCell('Start index',sourceMetric(group,['start_index','startIndex','offset'])));const body=el('div','source-result-details');for(const result of group){renderSingleResult({...data,result});const node=sections.lastElementChild,heading=node?.querySelector('h3');if(heading&&result?.subject?.label)heading.textContent='Result · '+formatDisplayNarrative(result.subject.label,result);if(node)body.append(node)}details.append(summary,body);details.ontoggle=()=>window.apiosk.resize();return details}
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
  const list=el('div','source-results-list'),groups=new Map();disclosure.append(list);s.append(disclosure);
  for(const result of results){if(cbs?.records.includes(result))continue;const key=sourceGroupKey(result);if(!groups.has(key))groups.set(key,[]);groups.get(key).push(result)}
  for(const group of groups.values())list.append(renderSourceGroup(data,group));
 }
 if(surface?.title){byId('title').textContent=surface.title;byId('subtitle').textContent=surface.subtitle}
 const report=data.context_view?.report,analysis=data.context_view?.analysis;
 if(report||analysis){const s=surface?.section||el('section','section result-extras');if(!surface)sections.append(s);const links=surface?.links||el('div','result-links');if(!surface)s.append(links);
  if(report?.format==='pdf'&&typeof report.url==='string'&&report.url.startsWith('https://')){const download=el('button','text-action','Download PDF');download.onclick=()=>window.apiosk.openLink(report.url);links.append(download)}
  if(typeof report?.evidence_url==='string'&&report.evidence_url.startsWith('https://')){const download=el('button','text-action','Download evidence');download.onclick=()=>window.apiosk.openLink(report.evidence_url);links.append(download)}
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
