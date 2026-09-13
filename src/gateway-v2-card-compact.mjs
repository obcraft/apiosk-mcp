// The execution graph stays private; only consent, choices and results are visible.
export const V2_COMPACT_STYLE = `
.result-grid{max-height:420px;overflow:auto}.compact-details{font-size:13px;margin-top:10px}.compact-details>summary{cursor:pointer;padding:8px 0}.request-section .request-price{text-align:left;margin-top:14px}.request-section .request-price strong{font-size:22px}.choice-list{display:grid;gap:12px}.choice-list button>span:first-child{display:grid;gap:6px}.choice-list button{display:flex;justify-content:space-between;align-items:center;gap:16px;text-align:left;padding:16px;min-height:64px;border-color:var(--apiosk-accent-line)}.choice-section{background:var(--apiosk-soft)}.compact-status{padding:12px 0;font-size:14px}.compact-sources{display:grid;gap:10px;margin-top:12px}
@media(max-width:480px){.section{padding:16px}.section-title h3{font-size:17px}.actions button{min-height:44px}.plan-actions button{width:100%;min-width:0}}
`;
export const V2_CARD_COMPACT = `
renderPlan=function(data){
 const p=data.proposal;if(!p||['succeeded','partial','failed','unsupported','needs_selection'].includes(data.status))return;
 const details=p.step_details||[],subjects=[...new Set(details.map(d=>d.subject).filter(Boolean))];
 const sources=[...new Map(details.filter(d=>d.source).map(d=>[d.source.directory_slug||d.source.slug||d.source.name,{...d.source,name:d.source.directory_name||d.source.name}])).values()];
 const s=section(subjects.join(' · ')||p.label||'Data request');s.classList.add('request-section');planSurface=s;
 if(data.billing?.authorization_active||data.status==='running'){
  s.append(el('p','compact-status','Getting your data…'));
  s.append(el('p','meta','Approved up to '+money(p.max_total_atomic,p.currency,true)));return;
 }
 if(sources.length)s.append(el('p','meta',sources.length+(sources.length===1?' source':' sources')));
 const price=el('div','request-price');price.append(el('span','price-label','Maximum total'),el('strong','',money(p.max_total_atomic,p.currency,true)));s.append(price);
 s.append(el('p','meta','Approve once. The entire request stays within this amount.'));
 const disclosure=el('details','compact-details'),list=el('div','compact-sources');disclosure.append(el('summary','','Details'));
 for(const source of sources)list.append(sourceLine(source));disclosure.append(list);s.append(disclosure);
};
const renderExpandedCard=render;
render=function(data){
 renderExpandedCard(data);if(!data||typeof data!=='object')return;
 for(const section of sections.querySelectorAll(':scope > .section')){
  const heading=section.querySelector('h3');
  if(heading?.textContent==='Payment summary'){
   const charged=money(data.billing?.total_charged,data.billing?.currency),disclosure=el('details','compact-details');
   disclosure.append(el('summary','',charged==null?'Payment details':'Charged '+charged+(data.billing?.reserved&&data.billing.reserved!=='0'?' · Reserved '+money(data.billing.reserved,data.billing.currency):'')+' · Payment details'));
   const grid=section.querySelector('.balances');if(grid)disclosure.append(grid);section.replaceChildren(disclosure);
  }
 }
 for(const detail of data.proposal?.step_details||[]){if(detail.error?.message&&!(data.errors||[]).some(e=>e.message===detail.error.message))section('Needs attention').append(el('p','notice error',detail.error.message))}
 if(planSurface){const disclosure=planSurface.querySelector('.compact-details');if(disclosure)planSurface.append(disclosure)}
 if(typeof observeTask==='function')observeTask(data);
 window.apiosk.resize();
};
`;
