// Display only: join the returned CBS codebooks, never substitute missing values.
export function cbsAnnualView(data, results) {
  const question = data.context_view?.conversation?.[0]?.question || '';
  const years = [...new Set(question.match(/\b(?:19|20)\d{2}\b/g) || [])].sort();
  if (!years.length || years.length > 2) return null;
  const base = '/odata/v1/CBS/85809NED/';
  const observations = results.find(r => r.source?.provider === 'cbs-statline' && r.source.path === base + 'Observations');
  const entity = observations?.subject?.entity_ref;
  if (!entity) return null;
  const names = ['Observations', 'MeasureCodes', 'PeriodenCodes', 'BedrijfstakkenBranchesSBI2008Codes', 'BedrijfsgrootteCodes', 'Properties'];
  const records = names.map(name => results.find(r => r.source?.provider === 'cbs-statline' && r.source.path === base + name && r.subject?.entity_ref === entity));
  if (records.some(r => !r?.data || r.coverage === 'partial')) return null;
  const [values, measures, periods, sectors, sizes, properties] = records.map(r => r.data);
  if (![values, measures, periods, sectors, sizes].every(d => Array.isArray(d.value))) return null;
  const selected = values.value.filter(r => years.some(year => r.Perioden === year + 'JJ00'));
  if (!selected.length || years.some(year => !selected.some(r => r.Perioden === year + 'JJ00'))) return null;
  const rows = [];
  for (const row of selected) {
    const measure = measures.value.find(v => v.Identifier === row.Measure);
    const period = periods.value.find(v => v.Identifier === row.Perioden);
    const sector = sectors.value.find(v => v.Identifier === row.BedrijfstakkenBranchesSBI2008);
    const size = sizes.value.find(v => v.Identifier === row.Bedrijfsgrootte);
    if (!measure?.Title || !measure.Unit || !period?.Title || !sector?.Title || !size?.Title) return null;
    rows.push({period:period.Title.trim(), measure:measure.Title, unit:measure.Unit,
      code:row.Measure, value:typeof row.Value === 'number' && Number.isFinite(row.Value) ? row.Value : 'Niet beschikbaar',
      status:period.Status || 'Niet vermeld', sector:sector.Title, size:size.Title});
  }
  rows.sort((a,b) => a.period.localeCompare(b.period) || a.measure.localeCompare(b.measure));
  const scopes = [...new Set(rows.map(r => r.sector + ' · ' + r.size))];
  if (scopes.length !== 1) return null;
  const url = properties.Distributions?.find(d => /^https:\/\/(?:dataportal|opendata)\.cbs\.nl\//.test(d.AccessUrl || ''))?.AccessUrl;
  return {records, rows, subject:observations.subject.label, scope:scopes[0], title:properties.Title || observations.subject.label,
    modified:properties.Modified || properties.ModificationDate, retrieved:observations.source.retrieved_at, url};
}

export const V2_CARD_CBS = `
${cbsAnnualView.toString()}
function renderCbsAnnual(view){
 const s=section(view.subject||view.title);s.classList.add('answer-section');
 const number=value=>typeof value==='number'?new Intl.NumberFormat('nl-NL',{maximumFractionDigits:6}).format(value):value;
 const growth=view.rows.filter(r=>r.code==='M004926'&&r.unit==='%'),latest=growth.at(-1);
 if(latest){s.append(el('p','answer-number',(typeof latest.value==='number'&&latest.value>0?'+':'')+number(latest.value)+(typeof latest.value==='number'?'%':'')));s.append(el('p','answer-caption','Omzet in '+latest.period+' ten opzichte van '+(Number(latest.period)-1)));const previous=growth.at(-2);if(previous)s.append(el('p','meta','In '+previous.period+': '+number(previous.value)+(typeof previous.value==='number'?'%':'')+' ten opzichte van '+(Number(previous.period)-1)))}
 const states=[...new Set(view.rows.map(r=>r.status))];s.append(el('p','answer-source','CBS StatLine'+(states.length===1?' · '+states[0]:'')));
 const links=el('div','result-links');if(view.url){const link=el('button','text-action','Bron bekijken');link.onclick=()=>window.apiosk.openLink(view.url);links.append(link)}s.append(links);
 const full=el('details','compact-details result-details');full.append(el('summary','','Details'));full.ontoggle=()=>window.apiosk.resize();
 full.append(el('p','meta',view.scope));
 const wrap=el('div','cbs-table-wrap'),table=el('table','cbs-table'),head=el('tr');for(const label of ['Jaar','Maatstaf','Waarde','Eenheid','Status'])head.append(el('th','',label));const thead=el('thead');thead.append(head);table.append(thead);const body=el('tbody');
 for(const row of view.rows){const tr=el('tr');for(const value of [row.period,row.measure,number(row.value),row.unit,row.status])tr.append(el('td','',value));body.append(tr)}table.append(body);wrap.append(table);full.append(wrap);
 if(view.modified)full.append(el('p','meta','CBS bijgewerkt: '+new Date(view.modified).toLocaleDateString('nl-NL')));
 if(view.retrieved)full.append(el('p','meta','Opgehaald: '+new Date(view.retrieved).toLocaleString('nl-NL')));
 const raw=el('details','full-result');raw.append(el('summary','','Brongegevens'),el('pre','',JSON.stringify(view.records,null,2)));full.append(raw);s.append(full);
 if(!latest)full.open=true;
 return {section:s,details:full,links};
}
`;

export const V2_CBS_STYLE = '.cbs-table-wrap{overflow-x:auto}.cbs-table{width:100%;border-collapse:collapse;font-size:12px;text-align:left}.cbs-table th,.cbs-table td{padding:9px 7px;border-bottom:1px solid color-mix(in srgb,CanvasText 12%,transparent)}.cbs-table th{font-weight:600}.cbs-table td:nth-child(3){white-space:nowrap;font-variant-numeric:tabular-nums}';
