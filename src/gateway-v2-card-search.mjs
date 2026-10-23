// Runs inside the card: the source search view (`view: "source_search"`), as
// the App's Ask v2 source table draws it. Selecting is local and free; the
// selection module asks the gateway for one quote before explicit approval.
import { NO_RESULTS } from './gateway-v2-ask.mjs';
export const V2_CARD_SEARCH = `
function searchPriceAtomic(candidate){
 const exact=candidate?.endpoint?.price?.buyer_atomic;if(typeof exact==='string'&&/^\\d+$/.test(exact))return exact;
 const match=String(candidate?.price??'').trim().match(/^(\\d+)(?:\\.(\\d{1,6}))?(?:\\s+USDC?)?$/i);
 return match?String(BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'))):null}
function searchInputLabel(input){
 const names={'company.name':'Company name','company_registry.kvknummer':'KVK number','company.registration.lei':'LEI code','domain.name':'Website domain','web.query':'Search query'};
 return input?.schema?.title||names[input?.field]||pretty(input?.field||'')}
function searchRow(candidate,match){
 const source=candidate.endpoint?.source||{},row=el('div','search-row'),copy=el('div','search-copy'),side=el('div','search-side');
 const name=candidate.name||source.name||candidate.source_slug||'Source',supported=candidate.availability==='supported';
 copy.append(el('p','search-name',name));
 const about=candidate.description||candidate.endpoint?.description;if(about)copy.append(el('p','search-about',about));
 if(match?.related){const subject=sourceSearchSnapshot?.parsed_request?.subjects?.find(subject=>subject.id===candidate.subject_id);if(subject)copy.append(el('p','meta','For '+subject.label));if(candidate.selection_reason)copy.append(el('p','meta',candidate.selection_reason))}
 const inputs=supported?(candidate.endpoint?.inputs||[]).filter(input=>input?.required):[];
 if(inputs.length)copy.append(el('p','search-inputs','Needs '+inputs.map(searchInputLabel).filter(Boolean).join(', ')));
 const atomic=searchPriceAtomic(candidate),price=atomic&&money(atomic,'USD');
 const offered=supported&&selectableSource(candidate,match),state=supported?(offered?'Available':offeredSourceOption(candidate,match)||!Array.isArray(sourceSearchSnapshot?.source_options)?'Refresh to select':'Not selectable'):({discovery_only:'Discovery only',unverified:'Unverified'})[candidate.availability]||pretty(candidate.availability||'Unverified');
 side.append(el('span','search-price',price||'—'),el('span','search-state'+(offered?' supported':''),state));
 row.append(sourceLogo({name,logo_url:candidate.logo_url||source.logo_url}),copy,side);attachSourceChoice(row,copy,side,candidate,match);attachExternalChoice(side,candidate,match);return row}
function renderSearchContext(data){
 if(typeof data.planning_message==='string'&&data.planning_message.trim())section('Your request').append(el('p','notice',data.planning_message));
 for(const subject of (Array.isArray(data.company_context)?data.company_context:[]).slice(0,4)){
  if(!subject||typeof subject.company!=='string')continue;
  const s=section('Web context · '+subject.company),pages=Array.isArray(subject.pages)?subject.pages:[];
  if(!pages.length)s.append(el('p','meta',subject.search_status==='loading'?'Web context is loading.':'No web context is available for this subject.'));
  for(const page of pages.slice(0,9)){
   if(!page||typeof page!=='object')continue;
   let url;try{const parsed=new URL(page.url);if(!['https:','http:'].includes(parsed.protocol)||parsed.username||parsed.password)continue;url=parsed.href}catch{continue}
   const row=el('div','search-copy'),link=el('button','text-action',page.title||page.publisher||url);link.onclick=()=>window.apiosk.openLink(url);row.append(link);
   if(typeof page.description==='string'&&page.description)row.append(el('p','meta',page.description));
   if(typeof page.retrieved_at==='string'&&page.retrieved_at)row.append(el('p','meta','Retrieved '+page.retrieved_at));s.append(row);
  }
  if(subject.search_status==='unavailable'||subject.homepage_status==='unavailable')s.append(el('p','meta','Some web context could not be loaded.'));
 }
}
let researchPreparation=null;
function renderSearchPlan(data){
 if(!sourceSelectionQuestion||!data.search_id||!data.parsed_request||(data.parsed_request.capabilities||[]).every(capability=>capability.slug==='general.conversation'))return;
 const s=section('Plan the complete request'),button=el('button','primary plan-search','Prepare one plan');button.type='button';button.disabled=!window.apiosk.can.callTool;
 s.append(el('p','meta','Ask Apiosk to plan the complete question from these sources. Review one total price and approve before execution.'),button);
 button.onclick=async()=>{
  if(busy)return;const question=sourceSelectionQuestion,research={parsed_request:data.parsed_request,search_id:data.search_id,...(data.discovery_id?{discovery_id:data.discovery_id}:{})},fingerprint=JSON.stringify({question,research});
  if(researchPreparation?.fingerprint!==fingerprint)researchPreparation={fingerprint,request_id:sourceRequestId()};
  busy=true;button.disabled=true;showFeedback('Preparing one plan from the displayed sources…');
  try{const next=await window.apiosk.callTool('apiosk_ask',{question,research,request_id:researchPreparation.request_id});acceptResponse(next);if(['source_refresh_required','search_refresh_required'].includes(next?.error_code)||(next?.errors||[]).some(error=>['source_refresh_required','search_refresh_required'].includes(error.code)))showSourceRefresh()}
  catch(error){showFeedback(error?.message||'The plan could not be confirmed. Try again to recover the same request.','error')}
  finally{busy=false;button.disabled=false}
 };
}
function renderSourceSearch(data){
 const matches=sourceSearchGroups({...data,matches:Array.isArray(data.matches)?data.matches:[]}),capabilities=data.parsed_request?.capabilities||[];let total=0;
 beginSourceSelection(data,matches);renderSearchContext(data);
 if(data.planning_message&&capabilities.length&&capabilities.every(capability=>capability.slug==='general.conversation')){byId('title').textContent='Your request';byId('subtitle').textContent='';return}
 for(const match of matches)total+=(match.apiosk?.length||0)+(match.coinbase?.length||0);
 if(!total){const incomplete=matches.some(match=>['pending','unavailable'].includes(match.coinbase_status));byId('title').textContent=incomplete?'Search incomplete':'No results';byId('subtitle').textContent='';const s=section('Sources');s.append(el('p','notice',data.message||(incomplete?'Some sources could not be searched. Try again shortly.':${JSON.stringify(NO_RESULTS)})));if(sourceSelectionQuestion)appendSourceRefresh(s);if(hasExternalBasket())renderSourceReview();renderSearchPlan(data);return}
 const related=matches.some(match=>match.related);byId('title').textContent=total+(related?(total===1?' source to review':' sources to review'):(total===1?' matching source':' matching sources'));
 byId('subtitle').textContent=Number.isInteger(data.apiosk_sources_searched)?'Searched '+data.apiosk_sources_searched+' Apiosk sources. Nothing is bought from this list.':'Nothing is bought from this list.';
 for(const match of matches){
  const capability=capabilities.find(c=>c?.slug===match.slug&&(match.subject_id===undefined||c.subject_id===match.subject_id)),candidates=[...(match.apiosk||[]),...(match.coinbase||[])];
  const s=section(match.related?'Related sources':capability?.name||pretty(match.slug||'Requested data'),candidates.length===1?'1 source':candidates.length+' sources');s.classList.add('search-section');
  if(match.related)s.append(el('p','meta','These sources are also offered for this question. Review their scope and inputs; they may cover only part of the requested information.'));
  const subject=(data.parsed_request?.subjects||[]).find(subject=>subject.id===match.subject_id);if(subject)s.append(el('p','meta','For '+subject.label));
  if(capability?.description)s.append(el('p','meta search-capability',capability.description));
  const list=el('div','search-list');list.setAttribute('role','list');
  for(const candidate of candidates){const row=searchRow(candidate,match);row.setAttribute('role','listitem');list.append(row)}
  if(candidates.length)s.append(list);else s.append(el('p','meta',match.duplicates_only?'These sources are listed above.':'No matching source was found for this part of the question.'));
  if(match.coinbase_status==='unavailable')s.append(el('p','meta','Coinbase Bazaar search is unavailable right now.'));
 }
 renderSourceReview();renderSearchPlan(data);if(data.message){const s=section('Search status');s.append(el('p','notice',data.message));if(sourceSelectionQuestion)appendSourceRefresh(s)}if(data.notice)section('About these results').append(el('p','meta',data.notice));
}
function renderAskConversation(data){
 byId('title').textContent=data.kind==='saved_answer'?'Answer from saved sources':data.kind==='clarification'?'One detail is needed':'New data is needed';byId('subtitle').textContent='';
 const s=section(data.kind==='saved_answer'?'Saved evidence':'Your question');if(data.message)s.append(el('p','notice',data.message));
 if(data.kind==='saved_answer'){
  s.append(el('p','meta','Your answer uses previously purchased sources. Reading each saved result is free.'));
  for(const [index,ref] of (data.task_refs||[]).entries()){const button=el('button','quiet','Read saved result '+(index+1));button.onclick=async()=>{if(busy)return;busy=true;button.disabled=true;try{acceptResponse(await window.apiosk.callTool('apiosk_status',{task_ref:ref}))}catch(error){showFeedback(error?.message||'The saved result could not be read. Try again.','error')}finally{busy=false;button.disabled=false}};s.append(button)}
 }else if(data.kind==='search'&&data.question){const button=el('button','primary','Find sources for this question');button.onclick=()=>refreshSourceSearch(button,data.question);s.append(button)}
 if(data.notice)s.append(el('p','meta',data.notice));
}
function renderUnsupported(data){
 const intake=data.context_view?.capability_intake;
 if(Array.isArray(intake?.matches)&&intake.matches.some(match=>(match.apiosk?.length||0)+(match.coinbase?.length||0)>0)){renderSourceSearch(intake);return}
 byId('title').textContent='No results';byId('subtitle').textContent='';
 const message=data.context_view?.conversation?.at(-1)?.reply||(data.errors||[]).find(error=>error.message)?.message||${JSON.stringify(NO_RESULTS)};
 section('Sources').append(el('p','notice',message));
}
`;
