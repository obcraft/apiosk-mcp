import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { cbsAnnualView } from '../src/gateway-v2-card-cbs.mjs';
const live = JSON.parse(readFileSync(new URL('./fixtures/cbs-annual-ui.json', import.meta.url)));
test('saved CBS result joins source years, units, status and scope without changing values', () => {
  const before=JSON.stringify(live),view=cbsAnnualView(live,live.context_view.results);
  assert.deepEqual(view.rows.map(r=>[r.period,r.value,r.unit,r.status]),[
    ['2024',120.3,'2021=100','Definitief'],['2024',3.6,'%','Definitief'],
    ['2025',128.6,'2021=100','Definitief'],['2025',6.9,'%','Definitief']]);
  assert.match(view.scope,/F Bouwnijverheid/);assert.match(view.scope,/1 of meer werkzame personen/);
  assert.equal(view.modified,'2026-08-20T00:00:00+02:00');
  assert.equal(view.url,'https://dataportal.cbs.nl/detail/CBS/85809NED');
  assert.equal(JSON.stringify(live),before);
});
test('CBS presentation never borrows a different entity codebook or invents unavailable numbers', () => {
  const data=structuredClone(live),records=data.context_view.results;
  const measures=records.find(r=>r.source.path.endsWith('/MeasureCodes'));
  measures.subject.entity_ref='another-entity';assert.equal(cbsAnnualView(data,records),null);
  measures.subject.entity_ref=live.context_view.results[0].subject.entity_ref;
  const observations=records.find(r=>r.source.path.endsWith('/Observations'));
  observations.data.value[0].Value=null;
  assert.ok(cbsAnnualView(data,records).rows.some(r=>r.value==='Niet beschikbaar'));
  observations.coverage='partial';assert.equal(cbsAnnualView(data,records),null);
});
test('missing requested year or unsupported source keeps generic source evidence visible', () => {
  const data=structuredClone(live),records=data.context_view.results;
  data.context_view.conversation[0].question='Vergelijk 2025 en 2026';
  assert.equal(cbsAnnualView(data,records),null);
  data.context_view.conversation[0].question='Vergelijk 2024 en 2025';
  for(const r of records)r.source.path=r.source.path.replace('85809NED','86414NED');
  assert.equal(cbsAnnualView(data,records),null);
});
