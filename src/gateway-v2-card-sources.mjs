// Runs inside the card: the source list, and what it is honest to print on it.
export const V2_CARD_SOURCES = `
/* Buyer-facing counts include only runtime-supported functions. Registered
   endpoints belong in the integration audit, never in this overview. */
function coverage(source){const r=source&&source.readiness,c=(r&&r.contracts)||{};
 if(!r||!r.status)return{label:'Availability unknown',unavailable:false};
 if(r.status==='blocked')return{label:'Not purchasable',unavailable:true};
 const usable=c.supported_endpoints||0;
 if(!usable)return{label:'Not executable',unavailable:true};
 return{label:text(usable)+(usable===1?' available function':' available functions'),unavailable:false}}
function renderSources(data){
 const rows=Array.isArray(data.sources)?data.sources:[];
 byId('title').textContent=data.total===1?'1 matching source':text(data.total||rows.length)+' matching sources';
 byId('subtitle').textContent='Choose a source or narrow the search.';
 const s=section('Sources',text(data.offset||0)+'–'+text((data.offset||0)+rows.length)+' of '+text(data.total||rows.length)),list=el('div','sources');
 for(const source of rows){
  const group=el('div'),row=el('div','source'),copy=el('div'),name=el('div','source-name',source.name||source.slug),meta=el('div','source-meta',[source.category,...(source.capabilities||[]).slice(0,2)].filter(Boolean).map(pretty).join(' · '));
  copy.append(name,meta);const reach=coverage(source);
  row.append(sourceLogo(source),copy,el('span','count'+(reach.unavailable?' unavailable':''),source.service_count?text(source.service_count)+' services':reach.label));
  group.append(row);
  if(Array.isArray(source.services)&&source.services.length){
   const count=source.matching_service_count||source.services.length,detail=el('details','compact-details');detail.append(el('summary','','View '+text(count)+(count===1?' service':' services')));
   for(const service of source.services){const item=el('div','source-service');item.append(el('strong','',service.name),el('p','meta',service.description));detail.append(item)}
   detail.ontoggle=()=>window.apiosk.resize();group.append(detail);
  }
  list.append(group);
 }
 s.append(list);const actions=el('div','actions');
 if(Number.isInteger(data.next_offset)){const b=el('button','quiet','Next page');b.onclick=async()=>{if(busy)return;busy=true;showFeedback('Loading the next sources…');try{const args={...input,offset:data.next_offset,limit:input.limit||20};render(await window.apiosk.callTool('apiosk_sources',args))}catch(e){showFeedback(e&&e.message||'Could not load the next page.','error')}finally{busy=false}};actions.append(b)}
 if(actions.childNodes.length)s.append(actions)
}
`;
