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
 row.append(sourceLogo({name,logo_url:candidate.logo_url||source.logo_url}),copy,side);attachSourceChoice(row,copy,side,candidate,match);return row}
function renderSourceSearch(data){
 const matches=sourceSearchGroups({...data,matches:Array.isArray(data.matches)?data.matches:[]}),capabilities=data.parsed_request?.capabilities||[];let total=0;
 beginSourceSelection(data,matches);
 for(const match of matches)total+=(match.apiosk?.length||0)+(match.coinbase?.length||0);
 if(!total){const incomplete=matches.some(match=>['pending','unavailable'].includes(match.coinbase_status));byId('title').textContent=incomplete?'Search incomplete':'No results';byId('subtitle').textContent='';section('Sources').append(el('p','notice',data.message||(incomplete?'Some sources could not be searched. Try again shortly.':${JSON.stringify(NO_RESULTS)})));return}
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
 renderSourceReview();if(data.notice)section('About these results').append(el('p','meta',data.notice));
}
function renderUnsupported(data){
 const intake=data.context_view?.capability_intake;
 if(Array.isArray(intake?.matches)&&intake.matches.some(match=>(match.apiosk?.length||0)+(match.coinbase?.length||0)>0)){renderSourceSearch(intake);return}
 byId('title').textContent='No results';byId('subtitle').textContent='';
 const message=data.context_view?.conversation?.at(-1)?.reply||(data.errors||[]).find(error=>error.message)?.message||${JSON.stringify(NO_RESULTS)};
 section('Sources').append(el('p','notice',message));
}
`;
