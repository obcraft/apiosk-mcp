// The execution graph stays private; only consent, choices and results are visible.
export const V2_CARD_COMPACT = `
renderPlan=function(data){
 const p=data.proposal;if(!p||['cancelled','succeeded','partial','failed','unsupported','needs_selection'].includes(data.status))return;
 const details=p.step_details||[],subjects=[...new Set(details.map(d=>d.subject).filter(Boolean))];
 const sources=[...new Map(details.filter(d=>d.source).map(d=>[d.source.directory_slug||d.source.slug||d.source.name,{...d.source,name:d.source.directory_name||d.source.name}])).values()];
 const s=section(formatDisplayNarrative(subjects.join(' · ')||p.label||'Data request',data));s.classList.add('request-section');planSurface=s;
 if(data.billing?.authorization_active||data.status==='running'){
  s.append(el('p','compact-status','Getting your data…'));
  // An automatic approval is the connection's standing rule, never shown as a click.
  s.append(el('p','meta',(data.billing?.approved_via==='connection_auto'?'Approved automatically up to ':'Approved up to ')+money(p.max_total_atomic,p.currency,true)+(data.billing?.approved_via==='connection_auto'?' · within this connection’s limits':'')));return;
 }
 if(sources.length)s.append(el('p','meta',sources.length+(sources.length===1?' source':' sources')));
 const price=el('div','request-price');price.append(el('span','price-label','Maximum total'),el('strong','',money(p.max_total_atomic,p.currency,true)));s.append(price);
 s.append(el('p','meta','Approve once. The entire request stays within this amount.'));
 // A live rule that did not cover this plan says why, so the click is not a surprise.
 const auto=data.context_view?.auto_approval;if(auto?.active&&!auto.applied&&auto.message)s.append(el('p','meta',auto.message));
 const disclosure=el('details','compact-details'),list=el('div','compact-sources');disclosure.append(el('summary','','Details'));
 for(const source of sources)list.append(sourceLine(source));disclosure.append(list);s.append(disclosure);
};
const renderExpandedCard=render;
render=function(data){
 renderExpandedCard(data);if(!data||typeof data!=='object')return;
 for(const section of sections.querySelectorAll(':scope > .section')){
  const heading=section.querySelector('h3');
  if(heading?.textContent==='Payment summary'){
   const dutch=!!cbsAnnualView(data,data.context_view?.results||[]),charged=money(data.billing?.total_charged,data.billing?.currency),disclosure=el('details','compact-details');
   disclosure.append(el('summary','',charged==null?(dutch?'Betalingsdetails':'Payment details'):(dutch?'Betaald ':'Charged ')+charged+(data.billing?.reserved&&data.billing.reserved!=='0'?' · Reserved '+money(data.billing.reserved,data.billing.currency):'')+(dutch?' · Betalingsdetails':' · Payment details')));
   const grid=section.querySelector('.balances');if(grid)disclosure.append(grid);section.replaceChildren(disclosure);
  }
 }
 for(const detail of data.proposal?.step_details||[]){if(detail.error?.message&&!(data.errors||[]).some(e=>e.message===detail.error.message))section('Needs attention').append(el('p','notice error',detail.error.message))}
 if(planSurface){const disclosure=planSurface.querySelector('.compact-details');if(disclosure)planSurface.append(disclosure)}
 if(typeof observeTask==='function')observeTask(data);
 window.apiosk.resize();
};
`;
