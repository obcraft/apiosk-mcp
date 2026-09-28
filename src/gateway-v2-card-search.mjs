// Runs inside the card: the source search view (`view: "source_search"`), as
// the App's Ask v2 source table draws it. Read-only: nothing here quotes,
// approves or buys; a row only says what a source is, costs and needs.
export const V2_CARD_SEARCH = `
function searchPriceAtomic(candidate){
 const exact=candidate?.endpoint?.price?.buyer_atomic;if(typeof exact==='string'&&/^\\d+$/.test(exact))return exact;
 const match=String(candidate?.price??'').trim().match(/^(\\d+)(?:\\.(\\d{1,6}))?(?:\\s+USDC?)?$/i);
 return match?String(BigInt(match[1])*1000000n+BigInt((match[2]||'').padEnd(6,'0'))):null}
function searchInputLabel(input){
 const names={'company.name':'Company name','company_registry.kvknummer':'KVK number','company.registration.lei':'LEI code','domain.name':'Website domain','web.query':'Search query'};
 return input?.schema?.title||names[input?.field]||pretty(input?.field||'')}
function searchRow(candidate){
 const source=candidate.endpoint?.source||{},row=el('div','search-row'),copy=el('div','search-copy'),side=el('div','search-side');
 const name=candidate.name||source.name||candidate.source_slug||'Source',supported=candidate.availability==='supported';
 copy.append(el('p','search-name',name));
 const about=candidate.description||candidate.endpoint?.description;if(about)copy.append(el('p','search-about',about));
 const inputs=supported?(candidate.endpoint?.inputs||[]).filter(input=>input?.required):[];
 if(inputs.length)copy.append(el('p','search-inputs','Needs '+inputs.map(searchInputLabel).filter(Boolean).join(', ')));
 const atomic=searchPriceAtomic(candidate),price=atomic&&money(atomic,'USD');
 side.append(el('span','search-price',price||'—'),el('span','search-state'+(supported?' supported':''),({supported:'Available',discovery_only:'Discovery only',unverified:'Unverified'})[candidate.availability]||pretty(candidate.availability||'Unverified')));
 row.append(sourceLogo({name,logo_url:candidate.logo_url||source.logo_url}),copy,side);return row}
function renderSourceSearch(data){
 const matches=Array.isArray(data.matches)?data.matches:[],capabilities=data.parsed_request?.capabilities||[],seen=new Set();let total=0;
 for(const match of matches)for(const candidate of [...(match.apiosk||[]),...(match.coinbase||[])]){const key=candidate.endpoint_id||candidate.url||(candidate.source_slug||candidate.name)+':'+(candidate.capability||'');if(!seen.has(key)){seen.add(key);total++}}
 byId('title').textContent=total===1?'1 matching source':total+' matching sources';
 byId('subtitle').textContent=Number.isInteger(data.apiosk_sources_searched)?'Searched '+data.apiosk_sources_searched+' Apiosk sources. Nothing is bought from this list.':'Nothing is bought from this list.';
 if(!matches.length)section('Sources').append(el('p','meta','No requested capability was recognised. Rephrase the question or browse all sources.'));
 for(const match of matches){
  const capability=capabilities.find(c=>c?.slug===match.slug),candidates=[...(match.apiosk||[]),...(match.coinbase||[])];
  const s=section(capability?.name||pretty(match.slug||'Requested data'),candidates.length===1?'1 source':candidates.length+' sources');s.classList.add('search-section');
  if(capability?.description)s.append(el('p','meta search-capability',capability.description));
  const list=el('div','search-list');list.setAttribute('role','list');
  for(const candidate of candidates){const row=searchRow(candidate);row.setAttribute('role','listitem');list.append(row)}
  if(candidates.length)s.append(list);else s.append(el('p','meta','No matching source was found for this part of the question.'));
  if(match.coinbase_status==='unavailable')s.append(el('p','meta','Coinbase Bazaar search is unavailable right now.'));
 }
 if(data.notice)section('About these results').append(el('p','meta',data.notice));
}
`;
