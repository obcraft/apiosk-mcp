import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ukSupplierSummary } from '../src/gateway-v2-card-answer.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/uk-supplier-ui.json',import.meta.url)));
const summary=data=>ukSupplierSummary(data,data.context_view.results);

test('UK supplier summary distinguishes active registration from incomplete onboarding',()=>{
  const before=JSON.stringify(fixture),view=summary(fixture);
  assert.equal(view.label,'Not fully verified');
  assert.match(view.summary,/UK entity is active/);
  assert.deepEqual(view.checks.map(c=>[c.label,c.status]),[['UK entity','pass'],['Ownership','unknown'],['Filed accounts','info'],['VAT','unknown'],['Director screening','review']]);
  assert.match(view.checks.at(-1).detail,/1 potential match · manual review/);
  assert.equal(JSON.stringify(fixture),before);
});

test('missing, partial and other-entity evidence cannot become verified checks',()=>{
  const data=structuredClone(fixture),results=data.context_view.results;
  results.find(r=>r.result_ref==='profile').coverage='partial';
  results.find(r=>r.result_ref==='psc').data.total_results=3;
  results.find(r=>r.result_ref==='psc').subject.entity_ref='other';
  for(const r of results.filter(r=>r.source.provider==='opensanctions'))r.coverage='partial';
  const view=summary(data);
  assert.notEqual(view.checks[0].status,'pass');
  assert.equal(view.checks[1].status,'unknown');
  assert.equal(view.checks[2].status,'unknown');
  assert.equal(view.checks[4].status,'unknown');
});

test('a completed task and empty screening never mean valid or cleared',()=>{
  const data=structuredClone(fixture);data.status='succeeded';
  data.context_view.results.find(r=>r.result_ref==='psc').data.total_results=1;
  data.context_view.results.push({subject:{entity_ref:'anthropic'},source:{provider:'ask-merlin'},data:{valid:true}});
  for(const r of data.context_view.results.filter(r=>r.source.provider==='opensanctions')){r.data.responses.q1.results=[];r.data.responses.q1.total.value=0}
  const view=summary(data);
  assert.equal(view.label,'Review required');
  assert.equal(view.checks[3].status,'review');
  assert.match(view.checks[3].detail,/identity match/);
  assert.equal(view.checks[4].status,'review');
  assert.match(view.checks[4].detail,/coverage/);
});

test('non-UK, running, historical and ambiguous profiles retain generic results',()=>{
  for(const mutate of [
    d=>d.context_view.conversation[0].question='Show annual accounts',
    d=>d.status='running',d=>d.context_view.worker_active=true,
    d=>d.context_view.analyzing=true,d=>d.context_view.result_is_historical=true,
    d=>d.context_view.results.push(structuredClone(d.context_view.results[1])),
    d=>delete d.context_view.results[1].subject.entity_ref,
  ]){const data=structuredClone(fixture);mutate(data);assert.equal(summary(data),null)}
});

test('a non-active entity and overdue accounts are visibly flagged without inventing validity',()=>{
  const data=structuredClone(fixture),profile=data.context_view.results[1].data;
  profile.company_status='dissolved';profile.accounts.next_accounts.overdue=true;
  const view=summary(data);
  assert.equal(view.checks[0].status,'review');assert.match(view.checks[0].detail,/dissolved/);
  assert.equal(view.checks[2].status,'review');assert.match(view.checks[2].detail,/overdue/);
});

test('an invalid VAT candidate does not mean the supplier has no VAT registration',()=>{
  const data=structuredClone(fixture);
  data.context_view.results.push({subject:{entity_ref:'anthropic'},source:{provider:'ask-merlin'},data:{data:{valid:false,vatNumber:'GB123456789'},coverage:{complete:true}}});
  const view=summary(data);
  assert.equal(view.label,'Not fully verified');
  assert.equal(view.checks[3].status,'unknown');
  assert.equal(view.checks[3].detail,'Candidate invalid · supplier VAT unverified');
});

test('malformed or incomplete screening payloads never claim no candidates',()=>{
  const data=structuredClone(fixture);
  for(const r of data.context_view.results.filter(r=>r.source.provider==='opensanctions'))r.data.responses={q1:{error:'upstream unavailable'}};
  assert.equal(summary(data).checks[4].detail,'Screening returned · manual review required');
});
