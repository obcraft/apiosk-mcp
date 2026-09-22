// Presentation of returned evidence only. This is not an onboarding approval,
// a compliance certification, or a replacement for the gateway's payment verdict.
export function ukSupplierSummary(data, results) {
  const context = data?.context_view || {};
  const question = context.conversation?.[0]?.question || '';
  const notices = Array.isArray(context.coverage_notices) ? context.coverage_notices : [];
  const ukCheck = notices.some(note => typeof note === 'string' && note.includes('complete roster of up to five active directors'))
    || (/\b(?:UK|British|United Kingdom)\b/i.test(question) && /supplier|onboard/i.test(question) && /VAT/i.test(question) && /director|screening/i.test(question));
  if (!ukCheck || context.worker_active || context.analyzing || context.result_is_historical || !['succeeded', 'partial'].includes(data.status)) return null;
  const profiles = results.filter(r => r.source?.provider === 'companies-house' && typeof r.data?.company_number === 'string' && typeof r.data?.company_status === 'string');
  if (profiles.length !== 1 || !profiles[0].subject?.entity_ref) return null;
  const profile = profiles[0], company = profile.data;
  const related = results.filter(r => r.subject?.entity_ref === profile.subject.entity_ref && r.coverage !== 'partial' && !r.error);
  const completeProfile = related.includes(profile);
  const psc = related.find(r => r.source?.provider === 'companies-house' && /persons-with-significant-control/.test(r.source.path || ''));
  const pscCount = Number.isInteger(psc?.data?.total_results) ? psc.data.total_results : null;
  const accounts = completeProfile ? company.accounts : null;
  const period = accounts?.last_accounts?.made_up_to;
  const overdue = accounts?.overdue === true || accounts?.next_accounts?.overdue === true;
  const vat = related.find(r => r.source?.provider === 'ask-merlin');
  const vatValue = vat?.data?.data?.valid ?? vat?.data?.valid;
  const invalidCandidate = vatValue === false;
  const screening = related.filter(r => r.source?.provider === 'opensanctions');
  const responses = screening.flatMap(r => Object.values(r.data?.responses || {}));
  const candidateCount = responses.reduce((count, response) => count + (Array.isArray(response?.results) ? response.results.length : 0), 0);
  const noCandidates = responses.length > 0 && responses.every(response => Array.isArray(response?.results) && response.results.length === 0 && response.total?.value === 0 && !response.error);
  const active = completeProfile && company.company_status === 'active';
  const checks = [
    {label:'UK entity', status:active?'pass':'review', detail:completeProfile ? company.company_status + ' · ' + company.company_number : 'Registration evidence incomplete'},
    {label:'Ownership', status:pscCount>0?'info':'unknown', detail:pscCount>0 ? pscCount + ' PSC records · ownership still needs review' : pscCount===0 ? 'Not established · no PSC records returned' : 'Not verified · no complete PSC result'},
    {label:'Filed accounts', status:overdue?'review':period?'info':'unknown', detail:period ? 'Period ' + period + (overdue?' · overdue':' · filing status only') : 'Not verified · no accounts period returned'},
    {label:'VAT', status:vat&&!invalidCandidate?'review':'unknown', detail:invalidCandidate ? 'Candidate invalid · supplier VAT unverified' : vatValue===true ? 'Number valid · supplier identity match needs review' : vat ? 'Validation returned · review validity and identity match' : 'Not verified · no validation result'},
    {label:'Director screening', status:screening.length?'review':'unknown', detail:candidateCount ? candidateCount + ' potential ' + (candidateCount===1?'match':'matches') + ' · manual review' : noCandidates ? 'No candidates returned · review roster coverage' : screening.length ? 'Screening returned · manual review required' : 'Not verified · no screening result'},
  ];
  const incomplete = data.status === 'partial' || checks.some(check => check.status === 'unknown');
  return {subject:company.company_name || profile.subject.label, label:incomplete?'Not fully verified':'Review required', checks,
    summary:active ? 'The UK entity is active. That does not establish full supplier-onboarding clearance.' : 'The saved checks do not establish an active, fully verified UK supplier.',
    note:'Missing evidence is not a failed check. A screening candidate is not a confirmed sanctions finding.'};
}

export const V2_CARD_ANSWER = `
${ukSupplierSummary.toString()}
function renderResearchAnswer(data,results){
 const uk=ukSupplierSummary(data,results),analysis=data.context_view?.analysis;
 if(!uk&&!analysis&&!results.length)return null;
 const s=section(uk?formatDisplayNarrative(uk.subject,data):analysis?'Answer':'Result');s.classList.add('answer-section');s.classList.add('research-answer');
 if(uk){
  const headline=el('p','answer-verdict',uk.label);headline.setAttribute('role','status');s.append(headline,el('p','answer-summary',uk.summary));
  const checks=el('dl','answer-checks');
  for(const check of uk.checks){const row=el('div','answer-check '+check.status);row.append(el('dt','',check.label),el('dd','',formatDisplayNarrative(check.detail,data)));checks.append(row)}
  s.append(checks,el('p','meta answer-caveat',uk.note));
 }else if(analysis?.observations?.length){
  if(data.status==='partial'||analysis.status==='partial')s.append(el('p','answer-verdict','Partial answer'));
  for(const observation of analysis.observations.slice(0,4))s.append(el('p','answer-summary',formatDisplayNarrative(observation.text,data)));
  if(analysis.limitations?.length)s.append(el('p','notice',formatDisplayNarrative(analysis.limitations[0],data)));
 }else{s.append(el('p','answer-summary',data.context_view?.analyzing?'Preparing an answer from the saved sources…':'Source data returned. A verified assessment is not available yet.'))}
 const links=el('div','result-links');s.append(links);
 return {section:s,links,title:uk?'Supplier verification':analysis?'Answer':'Source result',subtitle:uk?'Based on saved source evidence.':'Results and source details below.'};
}
`;

export const V2_ANSWER_STYLE = `
.research-answer{padding:14px 15px}.research-answer .section-title{margin-bottom:8px}.answer-verdict{font-size:17px;font-weight:650;margin:4px 0 6px}.answer-summary{font-size:12px;line-height:1.5;margin:6px 0}.answer-checks{margin:10px 0}.answer-check{display:grid;grid-template-columns:112px minmax(0,1fr);gap:12px;padding:5px 0;font-size:12px;line-height:1.4}.answer-check dt{font-weight:600}.answer-check dd{margin:0;overflow-wrap:anywhere}.answer-check.unknown dd,.answer-check.review dd{font-weight:500}.answer-caveat{font-size:10px;line-height:1.4;margin:8px 0}.source-results-section{padding:8px 15px}.source-results-section>.section-title{display:none}.source-results-toggle{margin:0;opacity:1}.source-results-toggle>summary{font-size:12px;font-weight:600;padding:8px 0;cursor:pointer}.source-results-toggle>summary:focus-visible{outline:2px solid var(--apiosk);outline-offset:3px}.source-results-list{display:grid;gap:6px;margin-top:8px;overflow-x:auto}.source-result-group{min-width:740px;margin:0;border:1px solid color-mix(in srgb,CanvasText 10%,transparent);border-radius:10px;opacity:1}.source-result-summary{display:grid;grid-template-columns:24px minmax(130px,1.25fr) minmax(110px,1fr) repeat(4,minmax(76px,.7fr)) 16px;align-items:center;gap:9px;padding:9px 10px;cursor:pointer;list-style:none}.source-result-summary::-webkit-details-marker{display:none}.source-result-summary::after{content:'›';grid-column:8;grid-row:1;justify-self:end;font-size:15px;opacity:.55}.source-result-group[open]>.source-result-summary::after{transform:rotate(90deg)}.source-result-name{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-result-cell{display:grid;min-width:0;gap:1px}.source-result-label{font-size:8px;text-transform:uppercase;letter-spacing:.04em;opacity:.5;white-space:nowrap}.source-result-value{font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.source-result-details{border-top:1px solid color-mix(in srgb,CanvasText 8%,transparent)}.source-result-details>.section{padding:12px 10px}.source-results-toggle .analysis-notes{margin-top:12px}
@media(max-width:480px){.research-answer,.source-results-section{padding:12px}.answer-check{grid-template-columns:100px minmax(0,1fr);gap:8px}.research-answer .section-title h3{font-size:15px}}
`;
