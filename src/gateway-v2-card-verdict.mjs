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

export const V2_CARD_VERDICT = `
${supplierVerdictAnalysis.toString()}
${supplierVerdictView.toString()}
function renderSupplierVerdict(view){
 const nl=view.language==='nl',t=(dutch,english)=>nl?dutch:english,value=v=>v!=null&&typeof v==='object'?JSON.stringify(v):text(v);
 const title=t('Leverancierscontrole','Supplier payment check'),s=section(title);s.classList.add('answer-section');s.classList.add('verdict-section');
 const banner=el('div','verdict-banner '+view.decision);banner.setAttribute('role','status');banner.append(el('span','verdict-icon',view.icon),el('strong','verdict-label',view.label));s.append(banner);
 if(view.reasons.length){const list=el('ul','verdict-reasons');for(const reason of view.reasons)list.append(el('li','',reason));s.append(list)}
 const p=view.supplier,parts=[p.name,p.kvk&&'KVK '+p.kvk,p.vat&&t('Btw ','VAT ')+p.vat,p.iban&&'IBAN '+p.iban,p.domain].filter(Boolean);
 if(parts.length)s.append(el('p','verdict-supplier',parts.join(' · ')));
 if(view.partial)s.append(el('p','notice',t('Niet alle controles zijn afgerond.','Not every check could be completed.')));
 const icons={pass:'✓',warn:'!',fail:'✕',unknown:'?'};
 if(view.checks.length){s.append(el('p','key',t('Controles','Checks')));const list=el('ul','verdict-checks');
  for(const check of view.checks){const row=el('li','verdict-check '+check.status),copy=el('div','check-copy');
   const icon=el('span','check-icon '+check.status,icons[check.status]);icon.setAttribute('aria-label',check.status);
   copy.append(el('p','check-label',check.label));
   if(check.detail)copy.append(el('p','check-detail',check.detail));
   if(check.status==='unknown')copy.append(el('p','check-source',t('Niet geverifieerd','Not verified')));
   if(check.source)copy.append(el('p','check-source',t('Bron: ','Source: ')+check.source));
   if(check.evidence.length){const evidence=el('details','evidence-details');evidence.append(el('summary','',t('Onderbouwing','Source evidence')));evidence.ontoggle=()=>window.apiosk.resize();for(const item of check.evidence)evidence.append(el('p','value',value(item.value)+(item.pointer?' · '+item.pointer:'')));copy.append(evidence)}
   row.append(icon,copy);list.append(row)}
  s.append(list)}
 for(const limitation of view.limitations)s.append(el('p','notice',limitation));
 const links=el('div','result-links');s.append(links);
 return {section:s,links,title,subtitle:t('Gecontroleerd met de teruggegeven bronnen.','Checked against the returned sources.')};
}
`;

export const V2_VERDICT_STYLE = ':root{--warn:#c7851a}.verdict-banner{display:flex;align-items:center;gap:10px;margin:4px 0 14px;padding:13px 14px;border:1px solid;border-radius:12px;font-size:15px;letter-spacing:-.01em}.verdict-banner.hold{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 38%,transparent);background:color-mix(in srgb,var(--bad) 12%,transparent)}.verdict-banner.review{color:var(--warn);border-color:color-mix(in srgb,var(--warn) 38%,transparent);background:color-mix(in srgb,var(--warn) 12%,transparent)}.verdict-banner.ok{color:var(--good);border-color:color-mix(in srgb,var(--good) 38%,transparent);background:color-mix(in srgb,var(--good) 12%,transparent)}.verdict-icon{font-size:18px}.verdict-reasons{margin:0 0 12px;padding-left:18px;font-size:13px;line-height:1.55}.verdict-supplier{margin:0 0 12px;font-size:12px;opacity:.72;overflow-wrap:anywhere}.verdict-checks{list-style:none;margin:6px 0 12px;padding:0}.verdict-check{display:grid;grid-template-columns:22px minmax(0,1fr);gap:9px;padding:9px 0;border-bottom:1px solid color-mix(in srgb,CanvasText 8%,transparent)}.verdict-check:last-child{border:0}.check-icon{display:grid;place-items:center;width:20px;height:20px;border-radius:50%;font-size:11px;font-weight:700}.check-icon.pass{color:var(--good);background:color-mix(in srgb,var(--good) 14%,transparent)}.check-icon.warn{color:var(--warn);background:color-mix(in srgb,var(--warn) 14%,transparent)}.check-icon.fail{color:var(--bad);background:color-mix(in srgb,var(--bad) 14%,transparent)}.check-icon.unknown{background:color-mix(in srgb,CanvasText 8%,transparent);opacity:.6}.verdict-check.unknown .check-copy{opacity:.6}.check-copy p{margin:0}.check-label{font-size:12px;font-weight:600}.check-detail{margin-top:2px!important;font-size:12px;line-height:1.5;overflow-wrap:anywhere}.check-source{margin-top:3px!important;font-size:10px;opacity:.62}.verdict-section .evidence-details{margin:4px 0 0}';
