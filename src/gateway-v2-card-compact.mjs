// Presentation only: keep consent, prices, status and errors accessible.
export const V2_COMPACT_STYLE = `
.steps{gap:10px;margin-top:12px}.step-title{font-size:14px}.step-source{font-size:12px}.compact-status{font-size:14px;margin:0 0 8px}.compact-details{opacity:1;font-size:13px;margin:0}.compact-details>summary{cursor:pointer;padding:8px 0;font-weight:500}.compact-details[open]>.balances{margin-top:8px}.section-title{margin-bottom:8px}.request-price .price-note{display:none}.notice.error{margin:10px 0 0}
@media(max-width:480px){.section,.plan-mode #sections>.section:first-child{padding:14px}.section-title h3,.plan-mode #sections>.section:first-child>.section-title h3{font-size:16px}.step-title,.result,.notice,.meta,.full-result>summary,.compact-details{font-size:14px}.step-source,.source-badge,.state{font-size:12px}.actions button{font-size:14px;min-height:44px}.plan-actions button{min-width:0;width:100%}.request-section>.section-title{flex-wrap:wrap}.request-price{text-align:left}.request-price strong{font-size:16px}.request-price .price-label{font-size:12px}.steps{gap:12px}}
`;
export const V2_CARD_COMPACT = `
const renderExpandedCard=render;
render=function(data){
 renderExpandedCard(data);
 if(!data||typeof data!=='object')return;
 const terminal=['succeeded','partial','failed','unsupported'].includes(data.status);
 if(planSurface){
  const details=data.proposal?.step_details||[];
  const subjects=[...new Set(details.map(d=>d.subject).filter(Boolean))];
  if(subjects.length===1){
   const heading=planSurface.querySelector('h3');if(heading)heading.textContent=subjects[0];
   for(const row of planSurface.querySelectorAll('.step p.step-title'))row.remove();
  }
  const sources=details.map(d=>d.source).filter(Boolean);
  if(sources.length&&sources.every(s=>(s.name||s.provider)===(sources[0].name||sources[0].provider))){
   for(const line of planSurface.querySelectorAll('.step-source'))line.remove();
   planSurface.querySelector('.section-title')?.after(sourceLine(sources[0]));
  }
  if(terminal){
   planSurface.querySelector('.request-price')?.remove();
   const status=el('p','compact-status',invokeLabel(data.status));planSurface.querySelector('.section-title')?.after(status);
   // Failure and refund messages remain visible outside the collapsed steps.
   for(const notice of planSurface.querySelectorAll('.step .notice.error'))planSurface.append(notice);
   const steps=planSurface.querySelector('.steps');
   if(steps){const disclosure=el('details','compact-details');disclosure.append(el('summary','','Steps ('+steps.children.length+')'),steps);planSurface.append(disclosure)}
  }
 }
 for(const section of sections.querySelectorAll(':scope > .section')){
  const heading=section.querySelector('h3');
  if(heading?.textContent==='Payment summary'){
   const charged=money(data.billing?.total_charged,data.billing?.currency);
   const disclosure=el('details','compact-details');
   disclosure.append(el('summary','',charged==null?'Payment details':'Charged '+charged+' · Payment details'));
   const grid=section.querySelector('.balances');if(grid)disclosure.append(grid);
   section.replaceChildren(disclosure);
  }
 }
 window.apiosk.resize();
};
`;
