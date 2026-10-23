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
const refreshArgs = (data = search(), search_id = data.search_id) => ({question:data.question,refresh:{parsed_request:data.parsed_request,search_id}});
const choices = h => h.nodes.get('sections').querySelectorAll('.source-choice');
const review = h => h.nodes.get('sections').querySelector('.review-sources');
const approve = h => h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent.startsWith('Approve up to'));
const changeSources = h => h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent === 'Change sources');
function nativeSavedQuote() {
  const original = search(), quote = ready();
  const options = original.source_options.map(option => { const source = { ...option.source }; delete source.endpoint; return { ...option, source }; });
  for (const match of original.matches) {
    delete match.subject_id;
    for (const source of match.apiosk) { delete source.endpoint; delete source.subject_id; }
  }
  delete original.source_options; delete original.search_id; delete original.view; delete original.question;
  quote.context_view.source_selection = { can_choose: true, question, search_id: 'saved-signed-proof', parsed_request: original.parsed_request, options, original_intake: original };
  quote.context_view.selected_sources = [
    { endpoint_id: 'registry', capability: registry.capability, subject_id: 'acme', input: { 'company.kvk': '00876543' } },
    { endpoint_id: 'mentions', capability: mentions.capability, subject_id: 'acme', input: { 'company.name': 'ACME saved spelling' } },
  ];
  return quote;
}

// Relevant shape from the recorded FCCA free search: only the Crunchbase
// profile matched, while KVK and Overheid were signed related choices.
function fccaRelatedSearch() {
  const name = 'Financial Crime Compliance Associates', subject_id = 's1';
  const requirement = { slug: 'company.profile', name: 'Company profile', subject_id, outputs: ['business_details', 'directors', 'ownership_structure'] };
  const native = (name, endpoint_id, capability, fields, input_values) => ({
    source: { origin: 'apiosk', name, endpoint_id, capability, availability: 'supported', description: name === 'Crunchbase' ? 'Retrieve one identified organization profile.' : 'Search a company register and return matching source records.' },
    subject_id, requirement, input_values,
    endpoint: { endpoint_id, capability, inputs: fields.map(field => ({ field, required: true, schema: { type: 'string' } })), input_values, price: { currency: 'USD', buyer_atomic: name === 'Crunchbase' ? '54347' : name === 'Overheid.io Public Data' ? '57500' : '21739' } },
  });
  const profile = native('Crunchbase', '9651025a-3f42-4d86-aa83-b0a9c05e28c4', 'company.crunchbase-profile', ['company.crunchbase_entity_id'], {});
  const kvk = native('KVK Business Register', '46e9d53a-1942-442a-a310-5e1a6b7f8297', 'company_registry.search', ['company.name', 'company_registry.kvknummer'], { 'company.name': name, 'company_registry.kvknummer': '91251982' });
  const overheid = native('Overheid.io Public Data', '7e58d830-1e94-41ff-9809-66552e9bc431', 'company_registry.search', ['company.name'], { 'company.name': name });
  return {
    protocol_version: '2', view: 'source_search', question: 'Verzamel de bedrijfsgegevens, bestuurders en eigendomsstructuur van Financial Crime Compliance Associates; KVK-nummer: 91251982.',
    search_id: 'signed-fcca-search', catalog_version: 'fcca-catalog',
    parsed_request: { subjects: [{ id: subject_id, label: name, type: 'company', identifiers: { kvk_number: '91251982' } }], capabilities: [requirement] },
    matches: [{ slug: requirement.slug, subject_id, apiosk: [{ ...profile.source, endpoint: profile.endpoint }], coinbase: [{ origin: 'coinbase', name: 'External context only', url: 'https://example.test/source', availability: 'discovery_only' }], coinbase_status: 'complete' }],
    source_options: [profile, kvk, overheid],
  };
}

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
  assert.deepEqual(client.calls()[0].args,refreshArgs());
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
  assert.deepEqual(client.calls()[1].args,refreshArgs());
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

for (const kind of ['skybridge', 'mcp-apps']) {
  test(`${kind}: a native saved quote refreshes missing descriptors for free and restores both saved source inputs`, async () => {
    const quote = nativeSavedQuote(), client = await host(kind, quote), { h } = client;
    assert.ok(approve(h));
    const change = changeSources(h), pending = change.onclick(); await flush(); await change.onclick();
    assert.equal(client.calls().length, 1, 'double click refreshes once');
    assert.deepEqual({ name: client.calls()[0].name, args: client.calls()[0].args }, { name: 'apiosk_ask', args: refreshArgs(search(),'saved-signed-proof') });
    const fresh = search(); fresh.search_id = 'fresh-signed-proof'; fresh.catalog_version = 'catalog-2';
    for (const option of fresh.source_options) delete option.source.endpoint;
    fresh.source_options.push({ source: { ...registry, endpoint_id: 'related-hidden-source', endpoint: undefined }, subject_id: 'acme', endpoint: { ...registry.endpoint, endpoint_id: 'related-hidden-source' } });
    await client.respond(0, fresh); await pending;
    assert.deepEqual(choices(h).map(choice => choice.checked), [true, true, false]);
    assert.equal(review(h).disabled, false);
    assert.equal(approve(h), undefined);
    assert.deepEqual(h.nodes.get('sections').querySelectorAll('.source-input').map(control => control.value), ['00876543', 'ACME saved spelling', '00123456']);
    await h.tick(0); await h.tick(350); await h.tick(2000);
    assert.equal(client.calls().length, 1, 'refreshing a saved quote neither prepares nor purchases');
    const reviewing = review(h).onclick(); await flush();
    assert.deepEqual(client.calls()[1].args.input.apiosk_source_selection_v1.selections, quote.context_view.selected_sources);
    assert.equal(client.calls()[1].args.input.apiosk_source_selection_v1.search_id, 'fresh-signed-proof');
    await client.respond(1, ready()); await reviewing;
  });

  test(`${kind}: an unknown free refresh reply preserves the saved quote and lets Change sources retry`, async () => {
    const client = await host(kind, nativeSavedQuote()), { h } = client;
    const pending = changeSources(h).onclick(); await flush();
    await client.respond(0, { status: 'failed', errors: [{ message: 'Temporary problem' }] }); await pending;
    assert.ok(approve(h), 'the existing quote remains visible');
    assert.equal(changeSources(h).disabled, false);
    assert.match(h.nodes.get('feedback-text').textContent, /could not be refreshed/);
    const retry = changeSources(h).onclick(); await flush();
    assert.deepEqual(client.calls().map(call => ({ name: call.name, args: call.args })), [0, 1].map(() => ({ name: 'apiosk_ask', args: refreshArgs(search(),'saved-signed-proof') })));
    await client.respond(1, search()); await retry;
    assert.deepEqual(choices(h).map(choice => choice.checked), [true, true]);
  });
}

test('restoring sources follows the same subject identity after refreshed subject IDs change', async () => {
  const client = await host('skybridge', nativeSavedQuote()), { h } = client;
  const pending = changeSources(h).onclick(); await flush();
  const fresh = search(); fresh.parsed_request.subjects[0].id = 'reparsed-acme';
  for (const match of fresh.matches) match.subject_id = 'reparsed-acme';
  for (const option of fresh.source_options) option.subject_id = 'reparsed-acme';
  await client.respond(0, fresh); await pending;
  assert.deepEqual(choices(h).map(choice => choice.checked), [true, true]);
  const reviewing = review(h).onclick(); await flush();
  assert.ok(client.calls()[1].args.input.apiosk_source_selection_v1.selections.every(selection => selection.subject_id === 'reparsed-acme'));
  await client.respond(1, ready()); await reviewing;
});

test('a reused subject ID for a different company cannot inherit saved choices or input values', async () => {
  const client = await host('skybridge', nativeSavedQuote()), { h } = client;
  const pending = changeSources(h).onclick(); await flush();
  const fresh = search(); fresh.parsed_request.subjects[0] = { id: 'acme', label: 'Different company', identifiers: { kvk: '00999999' } };
  await client.respond(0, fresh); await pending;
  assert.ok(choices(h).every(choice => !choice.checked));
  assert.equal(review(h).disabled, true);
  assert.deepEqual(h.nodes.get('sections').querySelectorAll('.source-input').map(control => control.value), ['00123456', 'ACME']);
  assert.equal(client.calls().length, 1);
});

test('refreshing a saved quote drops removed schema fields while retaining declared saved inputs', async () => {
  const quote = nativeSavedQuote(); quote.context_view.selected_sources[0].input['company.obsolete'] = 'old hidden value';
  const client = await host('skybridge', quote), { h } = client;
  const pending = changeSources(h).onclick(); await flush();
  await client.respond(0, search()); await pending;
  const reviewing = review(h).onclick(); await flush();
  assert.deepEqual(client.calls()[1].args.input.apiosk_source_selection_v1.selections[0].input, { 'company.kvk': '00876543' });
  await client.respond(1, ready()); await reviewing;
});

for (const kind of ['skybridge', 'mcp-apps']) {
  test(`${kind}: FCCA can freely choose ready KVK and Overheid when only a missing-input Crunchbase profile matched`, async () => {
    const data = fccaRelatedSearch(), original = structuredClone(data);
    data.source_options.push(structuredClone(data.source_options[1]));
    const client = await host(kind, data), { h } = client;
    assert.equal(choices(h).length, 3, 'duplicate option is rendered once');
    const text = flatten(h.nodes.get('sections')).join(' ');
    assert.match(text, /Related sources/); assert.match(text, /only part of the requested information/);
    assert.match(text, /External context only/); assert.match(text, /KVK Business Register/); assert.match(text, /Overheid.io Public Data/);
    await h.change(choices(h)[0], true); await review(h).onclick();
    assert.equal(client.calls().length, 0, 'missing Crunchbase entity is never guessed');
    await h.change(choices(h)[0], false); await h.change(choices(h)[1], true); await h.change(choices(h)[2], true);
    await h.tick(0); await h.tick(350); await h.tick(2000);
    assert.equal(client.calls().length, 0, 'choosing any offered sources is free');
    const pending = review(h).onclick(); await flush();
    assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections, original.source_options.slice(1).map(option => ({ endpoint_id: option.source.endpoint_id, capability: option.source.capability, subject_id: option.subject_id, input: option.input_values })));
    assert.deepEqual(Object.keys(client.calls()[0].args).sort(), ['input', 'question', 'request_id']);
    assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.parsed_request, original.parsed_request);
    assert.deepEqual(data.matches, original.matches, 'presentation cannot rewrite original matches');
    await client.respond(0, ready()); await pending;
    await changeSources(h).onclick();
    assert.equal(client.calls().length, 1, 'complete in-memory descriptors need no refresh or purchase');
    assert.deepEqual(choices(h).map(choice => choice.checked), [false, true, true]);
  });
}

test('option-only source choices are visible and same endpoint and capability remain distinct for two subjects', async () => {
  const data = fccaRelatedSearch(); data.matches = [];
  data.source_options = [data.source_options[2]];
  data.parsed_request.subjects.push({ id: 's2', label: 'Another company', type: 'company', identifiers: {} });
  const second = structuredClone(data.source_options[0]); second.subject_id = 's2'; second.requirement.subject_id = 's2'; second.input_values = { 'company.name': 'Another company' };
  data.source_options.push(second);
  const client = await host('skybridge', data), { h } = client;
  assert.equal(choices(h).length, 2);
  assert.equal(h.nodes.get('title').textContent, '2 sources to review');
  await h.change(choices(h)[0], true); await h.change(choices(h)[1], true);
  const pending = review(h).onclick(); await flush();
  const selections = client.calls()[0].args.input.apiosk_source_selection_v1.selections;
  assert.deepEqual(selections.map(selection => [selection.subject_id, selection.input['company.name']]), [['s1', 'Financial Crime Compliance Associates'], ['s2', 'Another company']]);
  await client.respond(0, ready()); await pending;
});

test('a saved related choice refreshes freely and restores its schema-bound source inputs', async () => {
  const fresh = fccaRelatedSearch(), original = structuredClone(fresh), quote = ready();
  delete original.matches[0].apiosk[0].endpoint;
  for (const option of original.source_options) delete option.endpoint;
  quote.context_view.source_selection = { can_choose: true, question: fresh.question, parsed_request: original.parsed_request, search_id: original.search_id, options: original.source_options, original_intake: original };
  quote.context_view.selected_sources = [{ endpoint_id: fresh.source_options[2].source.endpoint_id, capability: fresh.source_options[2].source.capability, subject_id: 's1', input: { 'company.name': 'FCCA saved spelling' } }];
  const client = await host('skybridge', quote), { h } = client;
  const pending = changeSources(h).onclick(); await flush();
  assert.deepEqual(client.calls().map(call => ({ name: call.name, args: call.args })), [{ name: 'apiosk_ask', args: refreshArgs(fresh) }]);
  await client.respond(0, fresh); await pending;
  assert.deepEqual(choices(h).map(choice => choice.checked), [false, false, true]);
  const reviewing = review(h).onclick(); await flush();
  assert.deepEqual(client.calls()[1].args.input.apiosk_source_selection_v1.selections, quote.context_view.selected_sources);
  await client.respond(1, ready()); await reviewing;
});

test('old related options without descriptors offer one explicit refresh and cannot loop or prepare hidden inputs', async () => {
  const data = fccaRelatedSearch(); for (const option of data.source_options.slice(1)) delete option.endpoint;
  const client = await host('skybridge', data), { h } = client;
  assert.equal(choices(h).length, 1, 'unknown related schemas are not invented');
  const refresh = h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent === 'Refresh sources');
  assert.ok(refresh); assert.equal(client.calls().length, 0);
  const pending = refresh.onclick(); await flush(); await refresh.onclick();
  await client.respond(0, data); await pending;
  await h.tick(0); await h.tick(350); await h.tick(2000);
  assert.equal(client.calls().length, 1, 'an old response never triggers an automatic refresh loop');
  assert.equal(refresh.disabled, false);
  assert.equal(choices(h).length, 1);
  assert.match(h.nodes.get('feedback-text').textContent, /could not be refreshed/);
});

test('a lost free related-source refresh leaves its button available for a single manual retry', async () => {
  const data = fccaRelatedSearch(); delete data.source_options[1].endpoint;
  const client = await host('skybridge', data), { h } = client;
  const refresh = h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent === 'Refresh sources');
  const pending = refresh.onclick(); await flush();
  client.calls()[0].reject(new Error('Connection interrupted')); await pending;
  await h.tick(0); await h.tick(350); await h.tick(2000);
  assert.equal(client.calls().length, 1); assert.equal(refresh.disabled, false);
  const retry = refresh.onclick(); await flush();
  assert.deepEqual(client.calls()[1].args, refreshArgs(data));
  await client.respond(1, fccaRelatedSearch()); await retry;
  assert.equal(choices(h).length, 3);
  assert.ok(choices(h).every(choice => !choice.checked));
});

test('ordinary free refresh clears drafts when the same subject ID now identifies a different company', async () => {
  const data = fccaRelatedSearch(); delete data.source_options[1].endpoint;
  const client = await host('skybridge', data), { h } = client;
  await h.change(choices(h)[1], true);
  const company = h.nodes.get('sections').querySelectorAll('.source-input').find(control => control.dataset.field === 'company.name');
  await h.change(company, 'Original company private draft');
  const refresh = h.nodes.get('sections').querySelectorAll('button').find(button => button.textContent === 'Refresh sources');
  const pending = refresh.onclick(); await flush();
  const fresh = fccaRelatedSearch();
  fresh.parsed_request.subjects[0] = { id: 's1', label: 'Different company', type: 'company', identifiers: { kvk_number: '00999999' } };
  for (const option of fresh.source_options.slice(1)) {
    option.input_values['company.name'] = 'Different company';
    if ('company_registry.kvknummer' in option.input_values) option.input_values['company_registry.kvknummer'] = '00999999';
  }
  await client.respond(0, fresh); await pending;
  assert.ok(choices(h).every(choice => !choice.checked));
  assert.equal(review(h).disabled, true);
  assert.ok(h.nodes.get('sections').querySelectorAll('.source-input').filter(control => control.dataset.field === 'company.name').every(control => control.value === 'Different company'));
  assert.equal(client.calls().length, 1, 'the identity change never prepares or purchases');
});

test('lookup by name uses only the advertised lookup field and switching back preserves declared identifier inputs',async()=>{
  const data=search(),endpoint=data.matches[0].apiosk[0].endpoint;
  endpoint.lookup={field:'company.name',resolves:['company.kvk'],schema:{type:'string',title:'Company name'}};
  endpoint.input_values={'company.name':'ACME'};
  const client=await host('skybridge',data),{h}=client;
  await h.change(choices(h)[0],true);
  const lookup=h.nodes.get('sections').querySelector('.source-lookup');assert.equal(lookup.checked,true);
  assert.equal(h.nodes.get('sections').querySelectorAll('.source-input').some(node=>node.dataset.field==='company.kvk'),false);
  let pending=review(h).onclick();await flush();
  assert.deepEqual(client.calls()[0].args.input.apiosk_source_selection_v1.selections[0].input,{'company.name':'ACME'});
  await client.respond(0,{error_code:'gateway.unavailable',message:'Try again'});await pending;
  await h.change(lookup,false);
  const kvk=h.nodes.get('sections').querySelectorAll('.source-input').find(node=>node.dataset.field==='company.kvk');
  await h.change(kvk,'00123456');pending=review(h).onclick();await flush();
  assert.deepEqual(client.calls()[1].args.input.apiosk_source_selection_v1.selections[0].input,{'company.kvk':'00123456'});
  await client.respond(1,ready());await pending;
});

for(const kind of ['skybridge','mcp-apps'])test(`${kind}: signed displayed discovery prepares one automatic plan only after clicking and keeps retry identity`,async()=>{
  const client=await host(kind),{h}=client,button=h.nodes.get('sections').querySelector('.plan-search');
  assert.ok(button);assert.equal(client.calls().length,0);
  let pending=button.onclick();await flush();await button.onclick();
  assert.equal(client.calls().length,1);const first=client.calls()[0];
  assert.equal(first.name,'apiosk_ask');assert.deepEqual(first.args.research,{parsed_request:search().parsed_request,search_id:'signed-search-proof'});
  assert.equal(first.args.question,question);assert.equal(first.args.selections,undefined);
  await client.respond(0,{error_code:'gateway.unavailable',message:'Try again'});await pending;
  pending=button.onclick();await flush();assert.equal(client.calls()[1].args.request_id,first.args.request_id);
  await client.respond(1,ready());await pending;assert.ok(approve(h));assert.equal(client.calls().length,2,'a prepared plan still awaits one approval');
});

test('empty and incomplete source searches retain a free retry without preparing or approving',async()=>{
  for(const incomplete of [false,true]){
    const data=search();data.matches=data.matches.map(row=>({...row,apiosk:[],coinbase:[],coinbase_status:incomplete?'unavailable':'complete'}));data.source_options=[];
    const client=await host('skybridge',data),{h}=client;
    const refresh=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Refresh sources');assert.ok(refresh);
    const pending=refresh.onclick();await flush();assert.deepEqual(client.calls()[0].args,refreshArgs());assert.equal(client.calls()[0].name,'apiosk_ask');
    await client.respond(0,search());await pending;assert.equal(choices(h).length,2);assert.equal(client.calls().length,1);
  }
});

test('source search displays the actual planning message and source dated web context without unsafe links',async()=>{
  const data=search();data.planning_message='Which financial year should be compared?';
  data.company_context=[{company:'ACME',search_status:'completed',homepage_status:'unavailable',pages:[{title:'Official ACME page',url:'https://example.test/acme',description:'Source description',retrieved_at:'2026-10-23T08:00:00Z'},{title:'Unsafe',url:'javascript:alert(1)'},{title:'Credentials',url:'https://user:pass@example.test/'}]}];
  const {h}=await host('skybridge',data),content=flatten(h.nodes.get('sections')).join(' ');
  assert.match(content,/Which financial year/);assert.match(content,/Official ACME page/);assert.match(content,/Retrieved 2026-10-23/);assert.match(content,/could not be loaded/);assert.doesNotMatch(content,/Unsafe|Credentials/);
});

for(const [schema,invalid,valid,expected,tag] of [
  [{type:'boolean'},'maybe','false',false,'SELECT'],
  [{type:'integer',minimum:0,maximum:5},'6','0',0,'INPUT'],
  [{type:'number',exclusiveMinimum:0},'0','0.5',0.5,'INPUT'],
  [{type:'string',enum:['NL','BE']},'FR','NL','NL','SELECT'],
  [{type:'array',items:{type:'integer'},minItems:1},'["1"]','[1,2]',[1,2],'TEXTAREA'],
  [{type:'object',required:['active'],properties:{active:{type:'boolean'}},additionalProperties:false},'{"active":"yes"}','{"active":false}',{active:false},'TEXTAREA'],
])test(`clarification preserves typed ${schema.type} values and rejects invalid declared input`,async()=>{
  const task={protocol_version:'2',status:'needs_input',state:{state_ref:'task',revision:1},context_view:{},next_actions:[{kind:'supply_input',action_id:'input-action',label:'Provide check.value',input_schema:{properties:{value:{...schema,title:'Requested value'}}}}]};
  const client=await host('skybridge',task),{h}=client,form=h.nodes.get('sections').querySelector('form'),field=form.children[0];assert.equal(field.tagName,tag);
  await h.change(field,invalid);await form.onsubmit({preventDefault(){}});assert.equal(client.calls().length,0);
  await h.change(field,valid);const pending=form.onsubmit({preventDefault(){}});await flush();
  assert.equal(client.calls()[0].name,'apiosk_execute');assert.deepEqual(client.calls()[0].args.input,{value:expected});
  await client.respond(0,ready());await pending;
});

const externalOffer=()=>({resource:'https://external.example.test/data',method:'GET',name:'External records',host:'external.example.test',description:'Records for a query',source:'External records',provider_atomic:10000,total_atomic:11000,inputs:[{field:'query.limit',name:'limit',location:'query',required:true,schema:{type:'integer',minimum:1,maximum:20}}]});
const externalPurchase=()=>({protocol_version:'2',view:'external_purchase',purchase_id:'external-purchase',status:'requires_approval',source:externalOffer(),quote:{quote_ref:'external-quote',max_total_atomic:'11000',currency:'USD',expires_at:'2099-01-01'},result:null,result_present:false,billing:null,error:null});
for(const kind of ['skybridge','mcp-apps'])test(`${kind}: standalone external source prepares freely, approves the exact price once and reads saved results freely`,async()=>{
  const api_id='bazaar:opaque-identifier',client=await host(kind,{protocol_version:'2',view:'external_source',api_id,source:externalOffer()}),{h}=client;
  const form=h.nodes.get('sections').querySelector('form'),field=form.querySelector('.source-input');
  await h.change(field,'21');await form.onsubmit({preventDefault(){}});assert.equal(client.calls().length,0);
  await h.change(field,'2');let pending=form.onsubmit({preventDefault(){}});await flush();assert.equal(client.calls()[0].name,'apiosk_external');assert.equal(client.calls()[0].args.action,'prepare');assert.deepEqual(client.calls()[0].args.input,{'query.limit':2});
  const quote=externalPurchase();await client.respond(0,quote);await pending;
  await h.tick(0);await h.tick(100);assert.equal(client.calls().length,1,'preparation never approves');
  pending=approve(h).onclick();await flush();await approve(h).onclick();assert.equal(client.calls().length,2);assert.equal(client.calls()[1].name,'apiosk_external_approve');assert.deepEqual(client.calls()[1].args,{purchase_id:'external-purchase',quote_ref:'external-quote',max_total_atomic:'11000'});
  const result={...quote,status:'succeeded',result_present:true,result:{records:[{name:'Saved external evidence'}]},billing:{status:'captured',charged_micro_usd:11000}};
  await client.respond(1,result);await pending;assert.equal(approve(h),undefined);assert.match(flatten(h.nodes.get('sections')).join(' '),/Saved external evidence/);
  pending=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Check status').onclick();await flush();assert.deepEqual(client.calls()[2].args,{action:'status',purchase_id:'external-purchase'});assert.equal(client.calls()[2].name,'apiosk_external');await client.respond(2,result);await pending;
  assert.equal(client.calls().filter(call=>call.name==='apiosk_external_approve').length,1);
});

test('an uncertain external approval blocks another approval until read-only status recovers the purchase',async()=>{
  const quote=externalPurchase(),client=await host('skybridge',quote),{h}=client;
  let pending=approve(h).onclick();await flush();await client.respond(0,{error_code:'gateway.unavailable',message:'Unconfirmed'});await pending;
  assert.equal(approve(h).disabled,true);await approve(h).onclick();assert.equal(client.calls().length,1);
  pending=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Check status').onclick();await flush();assert.equal(client.calls()[1].args.action,'status');
  await client.respond(1,{...quote,status:'running'});await pending;assert.equal(approve(h),undefined);assert.equal(client.calls().filter(call=>call.name==='apiosk_external_approve').length,1);
});

test('conversation saved-answer cards open only a returned saved task and new-data cards search only after a click',async()=>{
  const client=await host('skybridge',{protocol_version:'2',view:'conversation',question:'Summarize these records',kind:'saved_answer',task_refs:['one','two']}),{h}=client;
  const buttons=h.nodes.get('sections').querySelectorAll('button');assert.equal(buttons.length,2);assert.equal(client.calls().length,0);
  let pending=buttons[1].onclick();await flush();assert.equal(client.calls()[0].name,'apiosk_status');assert.deepEqual(client.calls()[0].args,{task_ref:'two'});await client.respond(0,ready());await pending;
  await client.update({protocol_version:'2',view:'conversation',question:'New records',kind:'search'});pending=h.nodes.get('sections').querySelector('button').onclick();await flush();assert.equal(client.calls()[1].name,'apiosk_ask');assert.deepEqual(client.calls()[1].args,{question:'New records'});await client.respond(1,{...search(),question:'New records'});await pending;
  await client.update({protocol_version:'2',view:'conversation',question:'Explain this',kind:'clarification',message:'Which record do you mean?'});assert.match(flatten(h.nodes.get('sections')).join(' '),/Which record do you mean/);assert.equal(client.calls().length,2);
});

test('an unsigned legacy source card refreshes by question instead of inventing a signed parse',async()=>{
  const data=search();delete data.search_id;
  const client=await host('skybridge',data),{h}=client;
  const button=h.nodes.get('sections').querySelectorAll('button').find(button=>button.textContent==='Refresh sources');
  const pending=button.onclick();await flush();assert.deepEqual(client.calls()[0].args,{question});
  await client.respond(0,search());await pending;
});

test('a pure conversation displays its planning reply without a misleading empty-source result',async()=>{
  const data=search();data.matches=[];data.source_options=[];data.planning_message='Hello. What would you like to find?';data.parsed_request.capabilities=[{slug:'general.conversation'}];
  const {h}=await host('skybridge',data);assert.equal(h.nodes.get('title').textContent,'Your request');assert.match(flatten(h.nodes.get('sections')).join(' '),/Hello\. What would you like to find/);assert.doesNotMatch(flatten(h.nodes.get('sections')).join(' '),/couldn.t find any results|No results/);
});
