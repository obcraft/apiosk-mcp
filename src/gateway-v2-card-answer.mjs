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

// The generic answer mirrors the App's Ask task view (GatewayV2Outputs): the
// full answer text, then blocks (answer_schema_version 2) or the presentation
// table. Without an analysis there is no answer section: the source result is
// drawn directly (see gateway-v2-card-research.mjs).
export const V2_CARD_ANSWER = `
${ukSupplierSummary.toString()}
function renderResearchAnswer(data,results){
 const uk=ukSupplierSummary(data,results),analysis=data.context_view?.analysis;
 if(!uk&&!analysis)return null;
 let s;
 if(uk){
  s=section(formatDisplayNarrative(uk.subject,data));s.classList.add('answer-section','research-answer');
  const headline=el('p','answer-verdict',uk.label);headline.setAttribute('role','status');s.append(headline,el('p','answer-summary',uk.summary));
  const checks=el('dl','answer-checks');
  for(const check of uk.checks){const row=el('div','answer-check '+check.status);row.append(el('dt','',check.label),el('dd','',formatDisplayNarrative(check.detail,data)));checks.append(row)}
  s.append(checks,el('p','meta answer-caveat',uk.note));
 }else{
  s=el('section','section answer-section research-answer');s.setAttribute('aria-label','Answer');sections.append(s);
  const question=data.context_view?.conversation?.at(-1)?.question||'',value=answerText(analysis,{results,question});
  if(data.status==='partial'||analysis.status==='partial')s.append(el('p','meta answer-partial','Some information is missing. Review the available results in Sources and details.'));
  if(value)s.append(renderAnswerText(value,{results,analysis}));
  const detail=isBlocksAnswer(analysis)?renderAnswerBlocks(analysis):renderAnswerPresentation(question,results,analysis);
  if(detail)s.append(detail);
 }
 const links=el('div','result-links');s.append(links);
 return {section:s,links,title:uk?'Supplier verification':'Answer',subtitle:uk?'Based on saved source evidence.':'Based on the saved source results.'};
}
`;
