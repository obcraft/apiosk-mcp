// Display only: the gateway decides. Every value stays a text node; no advice is added.
export function supplierVerdictAnalysis(data) {
  const current = data?.context_view?.analysis;
  if (current) return current;
  const saved = (data?.context_view?.conversation || []).filter(turn => turn?.output && typeof turn.output === 'object').at(-1);
  return saved?.output?.analysis || null;
}

export function supplierVerdictView(analysis) {
  const verdict = analysis?.verdict;
  if (analysis?.kind !== 'supplier_payment_check' || !verdict || typeof verdict !== 'object') return null;
  const decisions = {
    hold: {icon: '⚠️', en: 'HOLD PAYMENT', nl: 'BETALING TEGENHOUDEN'},
    review: {icon: '🔎', en: 'REVIEW BEFORE PAYING', nl: 'EERST CONTROLEREN'},
    ok: {icon: '✅', en: 'NO RED FLAGS FOUND', nl: 'GEEN RODE VLAGGEN GEVONDEN'},
  };
  const decision = decisions[verdict.decision];
  if (!decision) return null;
  const language = verdict.language === 'nl' ? 'nl' : 'en';
  const words = s => typeof s === 'string' && s.trim() ? s.trim() : null;
  // A label from another decision never reaches the banner.
  const label = [decision.en, decision.nl].includes(verdict.label) ? verdict.label : decision[language];
  const supplier = verdict.supplier && typeof verdict.supplier === 'object' ? verdict.supplier : {};
  const statuses = ['pass', 'warn', 'fail', 'unknown'];
  const checks = (Array.isArray(verdict.checks) ? verdict.checks : []).filter(c => c && typeof c === 'object' && words(c.label)).map(c => ({
    id: words(c.id), label: words(c.label), status: statuses.includes(c.status) ? c.status : 'unknown',
    detail: words(c.detail), source: words(c.source),
    evidence: (Array.isArray(c.evidence) ? c.evidence : []).filter(e => e && typeof e === 'object'),
  }));
  return {
    decision: verdict.decision, icon: decision.icon, label, language,
    partial: analysis.status === 'partial',
    reasons: (Array.isArray(verdict.reasons) ? verdict.reasons : []).map(words).filter(Boolean),
    supplier: {name: words(supplier.name), kvk: words(supplier.kvk_number), vat: words(supplier.vat_number), iban: words(supplier.iban_masked), domain: words(supplier.domain)},
    checks,
    limitations: (Array.isArray(analysis.limitations) ? analysis.limitations : []).map(words).filter(Boolean),
  };
}

// Pre-KYB check (gateway/docs/pre-kyb-check.md): the gateway's pre_kyb::evaluate
// decides; the card only shows decision, identity lines, checks and gaps.
export function preKybVerdictAnalysis(data) {
  return supplierVerdictAnalysis(data);
}

export function preKybVerdictView(analysis) {
  const verdict = analysis?.verdict;
  if (analysis?.kind !== 'pre_kyb_check' || !verdict || typeof verdict !== 'object') return null;
  const decisions = {pass: {icon: '✅', label: 'PASS'}, review: {icon: '🔎', label: 'REVIEW'}, reject: {icon: '⛔', label: 'REJECT'}};
  const decision = decisions[verdict.decision];
  if (!decision) return null;
  const words = s => typeof s === 'string' && s.trim() ? s.trim() : null;
  const scalar = v => typeof v === 'string' ? words(v) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : Array.isArray(v) ? v.map(scalar).filter(Boolean).join(', ') || null : null;
  const lines = v => (Array.isArray(v) ? v : []).map(words).filter(Boolean);
  const evidence = v => (Array.isArray(v) ? v : []).filter(e => e && typeof e === 'object');
  const statuses = ['pass', 'warn', 'fail', 'unknown', 'not_selected'];
  const subject = verdict.subject && typeof verdict.subject === 'object' ? verdict.subject : {};
  const identity = (Array.isArray(verdict.identity) ? verdict.identity : []).filter(i => i && typeof i === 'object' && words(i.label) && scalar(i.value)).map(i => ({
    id: words(i.id), label: words(i.label), value: scalar(i.value), source: words(i.source),
    result_ref: words(i.result_ref), retrieved_at: words(i.retrieved_at), evidence: evidence(i.evidence),
  }));
  const checks = (Array.isArray(verdict.checks) ? verdict.checks : []).filter(c => c && typeof c === 'object' && words(c.label)).map(c => ({
    id: words(c.id), label: words(c.label), status: statuses.includes(c.status) ? c.status : 'unknown',
    detail: words(c.detail), source: words(c.source), evidence: evidence(c.evidence),
  }));
  return {
    kind: 'pre_kyb_check', decision: verdict.decision, icon: decision.icon, label: decision.label,
    headline: words(verdict.headline), language: verdict.language === 'nl' ? 'nl' : 'en',
    partial: analysis.status === 'partial',
    reasons: lines(verdict.reasons), next_action: words(verdict.next_action),
    subject: {
      name: words(subject.name), country: words(subject.country), screening_level: words(subject.screening_level),
      registration: words(subject.registration), vat: words(subject.vat_number), domain: words(subject.domain), iban: words(subject.iban_masked),
    },
    identity, checks,
    coverage_gaps: lines(verdict.coverage_gaps),
    limitations: lines(analysis.limitations),
  };
}

export const V2_CARD_VERDICT = `
${supplierVerdictAnalysis.toString()}
${supplierVerdictView.toString()}
${preKybVerdictAnalysis.toString()}
${preKybVerdictView.toString()}
function renderPreKybVerdict(view){
 const title='Pre-KYB check',s=section(title);s.classList.add('answer-section');s.classList.add('verdict-section');
 const banner=el('div','verdict-banner '+view.decision);banner.setAttribute('role','status');banner.append(el('span','verdict-icon',view.icon),el('strong','verdict-label',view.label));s.append(banner);
 if(view.headline)s.append(el('p','verdict-headline',formatDisplayNarrative(view.headline,output)));
 const p=view.subject,parts=[p.name&&formatDisplayText(p.name),p.country,p.registration&&'Registration '+p.registration,p.vat&&'VAT '+p.vat,p.iban&&'IBAN '+p.iban,p.domain,p.screening_level&&p.screening_level+' screening'].filter(Boolean);
 if(parts.length)s.append(el('p','verdict-supplier',parts.join(' · ')));
 if(view.partial)s.append(el('p','notice','Not every check could be completed.'));
 if(view.identity.length){s.append(el('p','key','Identity'));const wrap=el('div','body-table-wrap'),table=el('table','body-table identity-table'),head=el('thead'),hr=el('tr'),body=el('tbody');
  for(const h of ['Field','Value','Source'])hr.append(el('th','',h));head.append(hr);
  for(const line of view.identity){const row=el('tr','identity-line');row.append(el('td','identity-label',formatDisplayNarrative(line.label,output)),el('td','identity-value',line.value),el('td','identity-source',line.source||'—'));body.append(row)}
  table.append(head,body);wrap.append(table);s.append(wrap)}
 const icons={pass:'✓',warn:'!',fail:'✕',unknown:'?',not_selected:'–'};
 if(view.checks.length){s.append(el('p','key','Checks'));const list=el('ul','verdict-checks');
  for(const check of view.checks){const row=el('li','verdict-check '+check.status),copy=el('div','check-copy');
   const icon=el('span','check-icon '+check.status,icons[check.status]);icon.setAttribute('aria-label',check.status);
   copy.append(el('p','check-label',formatDisplayNarrative(check.label,output)));
   if(check.detail)copy.append(el('p','check-detail',formatDisplayNarrative(check.detail,output)));
   if(check.status==='unknown')copy.append(el('p','check-source','Not verified'));
   if(check.status==='not_selected')copy.append(el('p','check-source','Enhanced only'));
   if(check.source)copy.append(el('p','check-source','Source: '+check.source));
   if(check.evidence.length){const evidence=el('details','evidence-details');evidence.append(el('summary','','Source evidence'));evidence.ontoggle=()=>window.apiosk.resize();for(const item of check.evidence)evidence.append(el('p','value',formatSourceValue(item.value,item.field||item.pointer,null,output)+(item.pointer?' · '+item.pointer:'')));copy.append(evidence)}
   row.append(icon,copy);list.append(row)}
  s.append(list)}
 if(view.reasons.length){s.append(el('p','key','Why'));const list=el('ul','verdict-reasons');for(const reason of view.reasons)list.append(el('li','',formatDisplayNarrative(reason,output)));s.append(list)}
 if(view.coverage_gaps.length){s.append(el('p','key','Not covered'));const list=el('ul','verdict-gaps');for(const gap of view.coverage_gaps)list.append(el('li','',formatDisplayNarrative(gap,output)));s.append(list)}
 if(view.next_action){s.append(el('p','key','Next step'));s.append(el('p','verdict-next',formatDisplayNarrative(view.next_action,output)))}
 for(const limitation of view.limitations)s.append(el('p','notice',formatDisplayNarrative(limitation,output)));
 s.append(el('p','notice verdict-scope','Preliminary screening before full KYB, not a replacement for it.'));
 const links=el('div','result-links');s.append(links);
 return {section:s,links,title,subtitle:'Checked against the returned registers.'};
}
function renderSupplierVerdict(view){
 const nl=view.language==='nl',t=(dutch,english)=>nl?dutch:english,value=v=>v!=null&&typeof v==='object'?JSON.stringify(v):text(v);
 const title=t('Leverancierscontrole','Supplier payment check'),s=section(title);s.classList.add('answer-section');s.classList.add('verdict-section');
 const banner=el('div','verdict-banner '+view.decision);banner.setAttribute('role','status');banner.append(el('span','verdict-icon',view.icon),el('strong','verdict-label',view.label));s.append(banner);
 if(view.reasons.length){const list=el('ul','verdict-reasons');for(const reason of view.reasons)list.append(el('li','',formatDisplayNarrative(reason,output)));s.append(list)}
 const p=view.supplier,parts=[formatDisplayText(p.name),p.kvk&&'KVK '+p.kvk,p.vat&&t('Btw ','VAT ')+p.vat,p.iban&&'IBAN '+p.iban,p.domain].filter(Boolean);
 if(parts.length)s.append(el('p','verdict-supplier',parts.join(' · ')));
 if(view.partial)s.append(el('p','notice',t('Niet alle controles zijn afgerond.','Not every check could be completed.')));
 const icons={pass:'✓',warn:'!',fail:'✕',unknown:'?'};
 if(view.checks.length){s.append(el('p','key',t('Controles','Checks')));const list=el('ul','verdict-checks');
  for(const check of view.checks){const row=el('li','verdict-check '+check.status),copy=el('div','check-copy');
   const icon=el('span','check-icon '+check.status,icons[check.status]);icon.setAttribute('aria-label',check.status);
   copy.append(el('p','check-label',formatDisplayNarrative(check.label,output)));
   if(check.detail)copy.append(el('p','check-detail',formatDisplayNarrative(check.detail,output)));
   if(check.status==='unknown')copy.append(el('p','check-source',t('Niet geverifieerd','Not verified')));
   if(check.source)copy.append(el('p','check-source',t('Bron: ','Source: ')+check.source));
   if(check.evidence.length){const evidence=el('details','evidence-details');evidence.append(el('summary','',t('Onderbouwing','Source evidence')));evidence.ontoggle=()=>window.apiosk.resize();for(const item of check.evidence)evidence.append(el('p','value',formatSourceValue(item.value,item.field||item.pointer,null,output)+(item.pointer?' · '+item.pointer:'')));copy.append(evidence)}
   row.append(icon,copy);list.append(row)}
  s.append(list)}
 for(const limitation of view.limitations)s.append(el('p','notice',formatDisplayNarrative(limitation,output)));
 const links=el('div','result-links');s.append(links);
 return {section:s,links,title,subtitle:t('Gecontroleerd met de teruggegeven bronnen.','Checked against the returned sources.')};
}
`;
