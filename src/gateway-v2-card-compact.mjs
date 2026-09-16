import { V2_VERDICT_STYLE } from './gateway-v2-card-verdict.mjs';
// The execution graph stays private; only consent, choices and results are visible.
export const V2_COMPACT_STYLE = `
${V2_VERDICT_STYLE}
.answer-section .answer-number{font-size:44px;font-weight:650;line-height:1.1;letter-spacing:-.045em;margin:22px 0 8px}.answer-caption{font-size:14px;margin:0 0 10px;line-height:1.5}.answer-source{font-size:12px;opacity:.65;margin:22px 0 8px}.result-links{display:flex;flex-wrap:wrap;gap:8px 20px}.result-links .text-action{background:transparent;border:0;border-radius:0;padding:4px 0;font-size:12px;min-height:32px;color:inherit;text-decoration:underline;text-underline-offset:3px;opacity:.8}.result-details{margin-top:12px}.result-details>summary{font-size:12px;opacity:.75}.analysis-notes{margin-top:20px}.analysis-notes .result{font-size:12px;line-height:1.6}.evidence-details{font-size:11px;opacity:.7;margin-bottom:14px}.result-extras{padding-top:8px;padding-bottom:8px}.result-grid{max-height:none}.controls{padding:8px 15px}.section:has(>.compact-details):last-child{padding-top:8px;padding-bottom:8px}.section:has(>.compact-details):last-child>details>summary{font-size:11px;opacity:.65}.compact-details{font-size:13px;margin-top:10px}.compact-details>summary{cursor:pointer;padding:8px 0}.request-section .request-price{text-align:left;margin-top:14px}.request-section .request-price strong{font-size:22px}.choice-list{display:grid;gap:12px}.choice-list button>span:first-child{display:grid;gap:6px}.choice-list button{display:flex;justify-content:space-between;align-items:center;gap:16px;text-align:left;padding:16px;min-height:64px;border-color:var(--apiosk-accent-line)}.choice-section{background:var(--apiosk-soft)}.compact-status{padding:12px 0;font-size:14px}.compact-sources{display:grid;gap:10px;margin-top:12px}
@media(max-width:480px){.section{padding:16px}.section-title h3{font-size:17px}.actions button{min-height:44px}.plan-actions button{width:100%;min-width:0}}
`;
export const V2_CARD_COMPACT = `
renderPlan=function(data){
 const p=data.proposal;if(!p||['cancelled','succeeded','partial','failed','unsupported','needs_selection'].includes(data.status))return;
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
