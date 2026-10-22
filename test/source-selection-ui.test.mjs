import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APIO_V2_CARD_HTML } from '../src/gateway-v2-card.mjs';
import { cardHarness, flatten, flush, plain } from './helpers/card-harness.mjs';

const question = 'Via Apiosk: Verzamel de bedrijfsgegevens en openbare vermeldingen voor ACME, KVK 00123456.';
const candidate = (id, capability, field, value) => ({
  origin: 'apiosk', name: id === 'registry' ? 'Registry profile' : 'Public mentions',
  description: 'A documented source', source_slug: id, capability, endpoint_id: id,
  availability: 'supported', price: '0.04',
  endpoint: {
    endpoint_id: id, capability, name: id, source: { slug: id, name: id },
    inputs: [{ field, required: true, schema: { type: 'string', title: field === 'company.kvk' ? 'KVK number' : 'Company name' } }],
    input_values: value === undefined ? {} : { [field]: value },
    price: { currency: 'USD', buyer_atomic: '40000' },
  },
});
const registry = candidate('registry', 'company.profile.fetch', 'company.kvk', '00123456');
const mentions = candidate('mentions', 'company.mentions.search', 'company.name', 'ACME');
const search = () => ({
  protocol_version: '2', view: 'source_search', question, search_id: 'signed-search-proof',
  catalog_version: 'catalog-1', apiosk_sources_searched: 112,
  source_options: [registry, mentions].map(source => ({ source: structuredClone(source), subject_id: 'acme' })),
  parsed_request: {
    meta: { text_sha256: 'original-question-hash' },
    subjects: [{ id: 'acme', label: 'ACME', identifiers: { kvk: '00123456' } }],
    capabilities: [
      { slug: 'company.profile.fetch', name: 'Company details', subject_id: 'acme', outputs: ['company_details'] },
      { slug: 'company.mentions.search', name: 'Public mentions', subject_id: 'acme', outputs: ['mentions'] },
    ],
  },
  matches: [
    { slug: registry.capability, subject_id: 'acme', apiosk: [structuredClone(registry)], coinbase: [], coinbase_status: 'skipped' },
    { slug: mentions.capability, subject_id: 'acme', apiosk: [structuredClone(mentions), { ...structuredClone(mentions), endpoint_id: 'unavailable', availability: 'discovery_only', name: 'Unavailable source' }], coinbase: [], coinbase_status: 'skipped' },
  ],
});
const ready = () => ({
  protocol_version: '2', status: 'ready', state: { state_ref: 'selected-task', revision: 1 },
  proposal: {
    quote_ref: 'combined-quote', expires_at: '2099-01-01', currency: 'USD', max_total_atomic: '80000', approval_url: 'https://app.apiosk.com/connect/approve',
    steps: [registry.capability, mentions.capability],
    step_details: [
      { title: 'Company details', source: { name: 'Registry profile' } },
      { title: 'Public mentions', source: { name: 'Public mentions' } },
    ],
  },
  billing: { authorization_active: false, quote_ref: 'combined-quote' },
  context_view: { execution_enabled: true, approval_mode: 'chatbot', execution_mode: 'server', worker_active: false },
  next_actions: [{ action_id: 'run-selected', kind: 'execute_quoted_step' }],
});
const choices = h => h.nodes.get('sections').querySelectorAll('.source-choice');
const review = h => h.nodes.get('sections').querySelector('.review-sources');
const approve = h => h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent.startsWith('Approve up to'));

async function host(kind, data = search()) {
  const directCalls = [], saved = [];
  const h = cardHarness(APIO_V2_CARD_HTML, kind === 'skybridge' ? {
    toolOutput: data,
    callTool(name, args) {
      return new Promise((resolve, reject) => directCalls.push({ name, args: plain(args), resolve, reject }));
    },
    setWidgetState(value) { saved.push(plain(value)); },
  } : null);
  if (kind === 'mcp-apps') {
    await h.initialize('Claude');
    await h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: data } });
  }
  return {
    h, saved,
    calls() { return kind === 'skybridge' ? directCalls : h.sent.filter(message => message.method === 'tools/call').map(message => ({ ...plain(message.params), rpcId: message.id, args: plain(message.params.arguments) })); },
    async respond(index, value) {
      if (kind === 'skybridge') directCalls[index].resolve({ structuredContent: value });
      else await h.message({ jsonrpc: '2.0', id: this.calls()[index].rpcId, result: { structuredContent: value } });
      await flush();
    },
    async update(value) {
      if (kind === 'skybridge') await h.globals({ toolOutput: value });
      else await h.message({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: value } });
    },
  };
}

for (const kind of ['skybridge', 'mcp-apps']) {
  test(`${kind}: free multi-selection prepares one combined quote, then explicit approval executes once and saves both results`, async () => {
    const client = await host(kind), { h } = client;
    assert.equal(choices(h).length, 2, 'discovery-only sources cannot be selected');
    assert.equal(review(h).disabled, true);
    await h.change(choices(h)[0], true); await h.change(choices(h)[1], true);
    assert.equal(review(h).textContent, 'Review 2 selected sources');
    await h.tick(0); await h.tick(350); await h.tick(2000);
    assert.equal(client.calls().length, 0, 'selection is local and free');

    const pending = review(h).onclick(); await flush(); await review(h).onclick();
    assert.equal(client.calls().length, 1, 'double click cannot prepare twice');
    const prepared = client.calls()[0];
    assert.equal(prepared.name, 'apiosk_ask');
    assert.equal(prepared.args.question, question);
    assert.equal(prepared.args.input.apiosk_source_selection_v1.search_id, 'signed-search-proof');
    assert.deepEqual(Object.keys(prepared.args).sort(),['input','question','request_id'],'cached host schemas preserve every transport field');
    assert.equal(prepared.args.endpoint_id,undefined,'manual selection cannot take the legacy autoapproval path');
    assert.deepEqual(prepared.args.input.apiosk_source_selection_v1.parsed_request, search().parsed_request);
    assert.match(prepared.args.request_id, /^[a-f0-9-]{36}$/i);
    assert.deepEqual(prepared.args.input.apiosk_source_selection_v1.selections, [
      { endpoint_id: 'registry', capability: registry.capability, subject_id: 'acme', input: { 'company.kvk': '00123456' } },
      { endpoint_id: 'mentions', capability: mentions.capability, subject_id: 'acme', input: { 'company.name': 'ACME' } },
    ]);
    assert.equal(approve(h), undefined, 'source list is not purchase consent');
    const quote = ready(); await client.respond(0, quote); await pending;
    assert.ok(approve(h), 'combined quote has one explicit approval');
    assert.equal(h.nodes.get('sections').querySelectorAll('button').filter(button => button.textContent.startsWith('Approve up to')).length, 1);
    await h.tick(0); await h.tick(350); await h.tick(2000);
    assert.equal(client.calls().length, 1, 'quoted sources are not automatically bought');

    const approval = approve(h).onclick(); await flush(); await approve(h).onclick();
    assert.equal(client.calls().length, 2);
    assert.equal(client.calls()[1].name, 'apiosk_approve');
    assert.equal(client.calls()[1].args.quote_ref, 'combined-quote');
    assert.equal(client.calls()[1].args.max_total_atomic, '80000');
    const approved = { ...quote, state: { ...quote.state, revision: 2 }, billing: { ...quote.billing, authorization_active: true } };
    await client.respond(1, approved); await approval; await h.tick(0); await h.tick(350);
    assert.equal(client.calls().length, 3);
    assert.equal(client.calls()[2].name, 'apiosk_execute');
    assert.equal(client.calls()[2].args.quote_ref, 'combined-quote');
    assert.equal(client.calls()[2].args.idempotency_key, 'run-selected');
    const results = [
      { result_ref: 'registry-result', source: { name: 'Registry profile' }, data: { name: 'ACME', kvk: '00123456' } },
      { result_ref: 'mentions-result', source: { name: 'Public mentions' }, data: { mentions: [{ title: 'ACME source record' }] } },
    ];
    const done = { ...approved, status: 'succeeded', state: { ...quote.state, revision: 3 }, next_actions: [], result: results.at(-1), context_view: { ...approved.context_view, results } };
    await client.respond(2, done);
    assert.ok(flatten(h.nodes.get('sections')).some(text => text.includes('ACME')));
    assert.equal(approve(h), undefined);
    if (kind === 'skybridge') assert.equal(client.saved.at(-1).privateContent.apioskResult.state.revision, 3);
    else assert.ok(h.sent.some(message => message.method === 'ui/update-model-context'), 'saved result is published to the MCP host');
    await client.update(done); await h.tick(0); await h.tick(350); await h.tick(2000);
    assert.equal(client.calls().filter(call => call.name === 'apiosk_execute').length, 1, 'reopening the saved result never buys again');
  });
}

test('deselecting sources changes only the combined selection and preserves declared source inputs', async () => {
  const data = search();
  data.matches[0].apiosk[0].endpoint.inputs.push(
    { field: 'company.active', required: false, schema: { type: 'boolean' } },
    { field: 'company.limit', required: false, schema: { type: 'integer' } },
  );
  Object.assign(data.matches[0].apiosk[0].endpoint.input_values, { 'company.active': false, 'company.limit': 0 });
  const client = await host('skybridge', data), { h } = client;
  await h.change(choices(h)[0], true); await h.change(choices(h)[1], true); await h.change(choices(h)[1], false);
  assert.equal(review(h).textContent, 'Review 1 selected source');
  assert.equal(client.calls().length, 0);
  const pending = review(h).onclick(); await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections, [{ endpoint_id: 'registry', capability: registry.capability, subject_id: 'acme', input: { 'company.kvk': '00123456', 'company.active': false, 'company.limit': 0 } }]);
  await client.respond(0, ready()); await pending;
});

test('missing schema-declared inputs block review until entered and do not invent fields', async () => {
  const data = search(); data.matches[0].apiosk[0].endpoint.input_values = {};
  const client = await host('skybridge', data), { h } = client;
  await h.change(choices(h)[0], true); await review(h).onclick();
  assert.equal(client.calls().length, 0);
  assert.match(h.nodes.get('feedback-text').textContent, /KVK number/);
  const control = h.nodes.get('sections').querySelectorAll('.source-input').find(node => node.dataset.field === 'company.kvk');
  assert.ok(control);
  await h.change(control, '00123456');
  const pending = review(h).onclick(); await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections[0].input, { 'company.kvk': '00123456' });
  await client.respond(0, ready()); await pending;
});

test('declared lists and objects preserve typed values and invalid JSON cannot prepare',async()=>{
  const data=search(),endpoint=data.matches[1].apiosk[0].endpoint;
  endpoint.inputs.push({field:'web.domains',required:false,schema:{type:'array',items:{type:'string'}}},{field:'web.filter',required:false,schema:{type:'object'}});
  endpoint.input_values['web.domains']=['kvk.nl'];endpoint.input_values['web.filter']={active:true,limit:0};
  const client=await host('skybridge',data),{h}=client;
  await h.change(choices(h)[1],true);
  const domains=h.nodes.get('sections').querySelectorAll('.source-input').find(node=>node.dataset.field==='web.domains');
  await h.change(domains,'[invalid');await review(h).onclick();assert.equal(client.calls().length,0);
  await h.change(domains,'["kvk.nl","example.com"]');
  const pending=review(h).onclick();await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections[0].input,{'company.name':'ACME','web.domains':['kvk.nl','example.com'],'web.filter':{active:true,limit:0}});
  await client.respond(0,ready());await pending;
});

test('same endpoint contracts and separate subjects retain distinct source choices', async () => {
  const data = search();
  const other = candidate('registry', 'company.officers.fetch', 'company.kvk', '00876543');
  data.parsed_request.capabilities.push({ slug: other.capability, name: 'Officers', subject_id: 'beta', outputs: ['officers'] });
  data.matches.push({ slug: other.capability, subject_id: 'beta', apiosk: [other], coinbase: [] });
  data.source_options.push({source:other,subject_id:'beta'});
  const client = await host('skybridge', data), { h } = client;
  await h.change(choices(h)[0], true); await h.change(choices(h)[2], true);
  const pending = review(h).onclick(); await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections.map(({ endpoint_id, capability, subject_id, input }) => ({ endpoint_id, capability, subject_id, input })), [
    { endpoint_id: 'registry', capability: registry.capability, subject_id: 'acme', input: { 'company.kvk': '00123456' } },
    { endpoint_id: 'registry', capability: 'company.officers.fetch', subject_id: 'beta', input: { 'company.kvk': '00876543' } },
  ]);
  await client.respond(0, ready()); await pending;
});

test('new question or catalog does not inherit the previous selection', async () => {
  const client = await host('skybridge'), { h } = client;
  await h.change(choices(h)[0], true);
  await client.update({ ...search(), question: 'Find another company', catalog_version: 'catalog-2' });
  assert.ok(choices(h).every(choice => !choice.checked));
  assert.equal(review(h).disabled, true);
  assert.equal(client.calls().length, 0);
});

test('legacy unsigned source results cannot prepare an executable selection', async () => {
  const data = search(); delete data.search_id;
  const client = await host('skybridge', data), { h } = client;
  for (const choice of choices(h)) await h.change(choice, true);
  if (review(h)) assert.equal(review(h).disabled, true);
  assert.equal(client.calls().length, 0);
});

test('supported display matches are selectable only when the exact endpoint, capability and subject are offered',async()=>{
  const data=search();
  data.matches[0].apiosk.push({...structuredClone(registry),endpoint_id:'unoffered',name:'Unoffered lookup'});
  data.source_options[1].subject_id='different-company';
  const client=await host('skybridge',data),{h}=client;
  assert.equal(choices(h).length,1);
  await h.change(choices(h)[0],true);
  const pending=review(h).onclick();await flush();
  assert.equal(client.calls()[0].args.input.apiosk_source_selection_v1.selections.length,1);
  assert.equal(client.calls()[0].args.input.apiosk_source_selection_v1.selections[0].endpoint_id,'registry');
  await client.respond(0,ready());await pending;
});

test('cached search results without authoritative source options offer a free refresh',async()=>{
  const data=search();delete data.source_options;
  const client=await host('skybridge',data),{h}=client;
  assert.equal(choices(h).length,0);
  const refresh=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Refresh sources');
  assert.ok(refresh);
  const pending=refresh.onclick();await flush();
  assert.deepEqual(client.calls()[0].args,{question});
  await client.respond(0,search());await pending;
  assert.equal(choices(h).length,2);
});

test('expired source proof preserves the choice and offers a free search refresh',async()=>{
  const client=await host('skybridge'),{h}=client;
  await h.change(choices(h)[0],true);
  const pending=review(h).onclick();await flush();
  await client.respond(0,{status:'needs_input',errors:[{code:'source_refresh_required',message:'Search again before reviewing these sources.'}]});await pending;
  assert.equal(choices(h)[0].checked,true);
  const refresh=h.nodes.get('feedback-actions').querySelectorAll('button').find(button=>button.textContent==='Refresh sources');
  assert.ok(refresh);
  const refreshing=refresh.onclick();await flush();
  assert.deepEqual(client.calls()[1].args,{question});
  assert.equal(client.calls()[1].name,'apiosk_ask');
  await client.respond(1,{...search(),search_id:'fresh-signed-proof'});await refreshing;
  assert.equal(choices(h)[0].checked,true);
  const next=review(h).onclick();await flush();
  assert.equal(client.calls()[2].args.input.apiosk_source_selection_v1.search_id,'fresh-signed-proof');
  await client.respond(2,ready());await next;
});

test('a failed free preparation reuses its request identity and edited inputs get a new identity',async()=>{
  const client=await host('skybridge'),{h}=client;
  await h.change(choices(h)[0],true);
  const first=review(h).onclick();await flush();
  client.calls()[0].reject(new Error('Connection interrupted'));await first;
  const retry=review(h).onclick();await flush();
  assert.equal(client.calls()[1].args.request_id,client.calls()[0].args.request_id);
  client.calls()[1].reject(new Error('Connection interrupted'));await retry;
  const control=h.nodes.get('sections').querySelector('.source-input');await h.change(control,'00876543');
  const edited=review(h).onclick();await flush();
  assert.notEqual(client.calls()[2].args.request_id,client.calls()[0].args.request_id);
  assert.equal(client.calls()[2].args.input.apiosk_source_selection_v1.selections[0].input['company.kvk'],'00876543');
  await client.respond(2,ready());await edited;
});

test('a recovered selected quote can change sources without losing its saved values or buying',async()=>{
  const original=search(),quote=ready();
  quote.context_view.source_selection={question,search_id:original.search_id,parsed_request:original.parsed_request,original_intake:original};
  quote.context_view.selected_sources=[{endpoint_id:'registry',capability:registry.capability,subject_id:'acme',input:{'company.kvk':'00876543'}}];
  const client=await host('skybridge',quote),{h}=client;
  const change=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Change sources');
  assert.ok(change);await change.onclick();
  assert.equal(client.calls().length,0);
  assert.deepEqual(choices(h).map(choice=>choice.checked),[true,false]);
  assert.equal(h.nodes.get('sections').querySelector('.source-input').value,'00876543');
  const pending=review(h).onclick();await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections,quote.context_view.selected_sources);
  await client.respond(0,ready());await pending;
});
