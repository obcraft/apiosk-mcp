import { V2_SOURCE_VALUE_FORMAT } from './source-value-format.mjs';
import { V2_CARD_BODY } from './gateway-v2-card-body.mjs';
// One source result, as the App shows it: the readable answer body (purchase
// panel), filing fields and KVK company rows (GatewayV2Result), then the full
// source data collapsed. Source JSON stays unchanged; formatting is display-only.
export const V2_CARD_RESULT = `
${V2_SOURCE_VALUE_FORMAT}
${V2_CARD_BODY}
function filingRows(fields,depth=0,rows=[],currency=null){if(depth>12||!Array.isArray(fields))return rows;for(const field of fields.slice(0,200)){if(rows.length>=100)break;if(field&&typeof field.key==='string'&&['string','number','boolean'].includes(typeof field.value))rows.push([field.key.replace(/([a-z])([A-Z])/g,'$1 $2'),formatSourceValue(field.value,field.key,sourceCurrency(field)||currency)]);if(field?.opendataFields)filingRows(field.opendataFields,depth+1,rows,currency)}return rows}
function resultBody(result){return result&&typeof result==='object'?result.data!==undefined?result.data:result.preview_data!==undefined?result.preview_data:result:result}
function companyTable(companies,body){
 const wrap=el('div','result-companies'),region=el('div','body-table-wrap'),table=el('table','body-table'),head=el('tr'),thead=el('thead'),tbody=el('tbody');
 wrap.append(el('p','meta',companies.length+' results shown'+(typeof body.totaal==='number'?' of '+body.totaal:'')+(typeof body.pagina==='number'?' · Page '+body.pagina:'')));
 for(const label of ['Company','KVK number','City'])head.append(el('th','',label));thead.append(head);
 for(const row of companies){const tr=el('tr');for(const value of [row.naam,row.kvkNummer,row.adres?.binnenlandsAdres?.plaats??'—'])tr.append(el('td','',value));tbody.append(tr)}
 table.append(thead,tbody);region.append(table);wrap.append(region);
 if(body.volgende)wrap.append(el('p','meta','The source has more results. This response contains the current page.'));
 return wrap}
function renderResult(data){if(data.result==null)return;byId('title').textContent=data.status==='partial'?'Partial source result':'Source result';byId('subtitle').textContent='Returned by the selected source.';
 const result=data.result,source=result&&result.source||{},subject=result?.subject?.label,s=section(typeof subject==='string'&&subject?'Result · '+formatDisplayNarrative(subject,result):'Result'),wrap=el('div','result'),body=displayData(resultBody(result)),currency=sourceCurrency(body);
 const companies=Array.isArray(body?.resultaten)&&body.resultaten.every(r=>typeof r?.naam==='string'&&typeof r?.kvkNummer==='string')?body.resultaten:null,filing=Array.isArray(body?.opendataFields);
 const report=result?.report,links=el('div','result-links');wrap.append(links);
 if(report?.format==='pdf'&&typeof report.url==='string'&&report.url.startsWith('https://')){const download=el('button','text-action','Download PDF');download.onclick=()=>window.apiosk.openLink(report.url);links.append(download)}
 if(companies)wrap.append(companyTable(companies,body));
 else if(filing){wrap.append(el('p','meta','Selected fields from the deposited annual accounts. '+(currency?'Currency: '+currency+'.':'No currency is specified in this response.')));const dl=el('dl','body-fields');for(const [key,value] of filingRows(body.opendataFields,0,[],currency)){const row=el('div','result-row');row.append(el('dt','key',key),el('dd','value',value));dl.append(row)}wrap.append(dl)}
 else wrap.append(answerBody(resultBody(result)));
 const origin=el('div','result-source');origin.append(sourceLine(source));
 if(typeof source.url==='string'&&source.url.startsWith('https://')){const link=el('button','text-action','View source');link.onclick=()=>window.apiosk.openLink(source.url);origin.append(link)}
 if(source.retrieved_at)origin.append(el('span','meta','Retrieved '+new Date(source.retrieved_at).toLocaleString()));
 const full=el('details','full-result');full.append(el('summary','','Full source data'),el('pre','',JSON.stringify(result,null,2)));full.ontoggle=()=>window.apiosk.resize();
 wrap.append(origin,full);s.append(wrap)}
`;
