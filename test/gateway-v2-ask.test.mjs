import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import schemas from '../src/gateway-v2-contracts.json' with { type: 'json' };
import { NO_RESULTS } from '../src/gateway-v2-ask.mjs';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';

const env = { APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082', APIOSK_CONNECT_TOKEN: 'fixture' };
const question = 'What time is it in Amsterdam? Check via Apiosk.';
// What Apiosk's own parser reads from that question.
const parsed = { language: 'en', subjects: [{ id: 's1', label: 'Amsterdam', type: 'city', identifiers: {} }],
  capabilities: [{ slug: 'location.time.current', name: 'Current local time', description: 'The current local time in a city.', domain: 'location', inputs: ['city'], outputs: ['local_time'], subject_id: 's1', source_hint: null, confidence: 0.9 }],
  deliverable: { format: 'chat', operations: [] } };
const endpoint = { endpoint_id: '7b0f4c0e-7a55-4a55-9d6e-0f3e7f0a1b2c', capability: 'location.time.current', name: 'World time', description: 'Local time',
  source: { slug: 'worldtime', name: 'World Time', logo_url: null, url: 'https://example.test' }, inputs: [{ field: 'location.city', required: true, schema: { type: 'string' } }],
  input_values: { 'location.city': 'Amsterdam' }, missing_inputs: [],
  lookup: null, price: { currency: 'USDC', provider_atomic: '1000', buyer_atomic: '1100' } };
// The public Ask answer: the App's parse and both origin searches, no task.
const answer = (apiosk, extra = {}) => ({ status: 'choices', question, parsed_request: parsed, model: 'fixture', attempts: 1, timing: { parse_ms: 4 }, apis: [],
  searches: { apiosk: { apiosk_sources_searched: 112, catalog_version: 'v1', timing: { search_ms: 3 }, ...apiosk } }, errors: [], execution: { method: 'POST', path: '/v2/execute' }, ...extra });

test('Ask accepts the same question length as the page, preserving clarification and free web context', async () => {
  const requests = [], context = [{ subject_id: 's1', label: 'Amsterdam', pages: [{ url: 'https://example.test', title: 'City' }] }];
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json(answer({ matches: [] }, { planning_message: 'Which city?', company_context: context, context_status: 'completed', discovery_id: 'external-proof', complete_plan_available: false }));
  } });
  const result = await runtime.callTool('apiosk_ask', { question: 'x'.repeat(16000) });
  assert.equal(result.isError, undefined);
  assert.equal(requests[0].question.length, 16000);
  assert.equal(result.structuredContent.message, 'Which city?');
  assert.deepEqual(result.structuredContent.company_context, context);
  assert.equal(result.structuredContent.discovery_id, 'external-proof');
  const tool = (await runtime.listTools()).find(tool => tool.name === 'apiosk_ask');
  assert.equal(new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(result.structuredContent).valid, true);
  assert.equal((await runtime.callTool('apiosk_ask', { question: 'x'.repeat(16001) })).isError, true);
  assert.equal(requests.length, 1);
});

test('complete planning reuses the exact displayed signed search without another discovery or approval', async () => {
  const requests = [], runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return Response.json({ protocol_version: '2', status: 'ready', next_actions: [], errors: [], billing: { authorization_active: false } });
  } });
  const args = { question, request_id: '00000000-0000-4000-8000-000000000123', research: { parsed_request: parsed, search_id: 'signed-search', discovery_id: 'external-proof' } };
  const result = await runtime.callTool('apiosk_ask', args);
  assert.equal(result.isError, undefined);
  assert.deepEqual(requests, [{ path: '/v2/ask/research', body: { question, request_id: args.request_id, ...args.research } }]);
  for (const invalid of [
    { ...args, task_refs: [args.request_id] }, { ...args, input: {} }, { ...args, endpoint_id: endpoint.endpoint_id },
    { ...args, research: { parsed_request: parsed } }, { ...args, research: { ...args.research, approved: true } },
  ]) assert.equal((await runtime.callTool('apiosk_ask', invalid)).isError, true);
  assert.equal(requests.length, 1);
});

test('retrying searches keeps the signed interpretation instead of parsing the question again', async () => {
  const requests = [], runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return Response.json(answer({ matches: [] }, { search_id: 'refreshed-proof' }));
  } });
  const refresh = { parsed_request: parsed, search_id: 'previous-proof' };
  const result = await runtime.callTool('apiosk_ask', { question, refresh });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.search_id, 'refreshed-proof');
  assert.deepEqual(requests, [{ path: '/v2/ask/search', body: { question, ...refresh } }]);
  for (const invalid of [{ question, refresh, research: refresh }, { question, refresh, selections: [] }, { question, refresh: { parsed_request: parsed } }]) {
    assert.equal((await runtime.callTool('apiosk_ask', invalid)).isError, true);
  }
  assert.equal(requests.length, 1);
});

test('saved-data follow-ups route on the gateway and never silently fall back to a new paid request', async () => {
  const task = '00000000-0000-4000-8000-000000000123', requests = [];
  let reply = { kind: 'saved_answer', task_refs: [task] }, status = 200;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    requests.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return Response.json(reply, { status });
  } });
  const args = { question: 'Summarize the bought records', task_refs: [task], request_id: task };
  for (const next of [{ kind: 'saved_answer', task_refs: [task] }, { kind: 'search' }, { kind: 'clarification', message: 'Which record?' }]) {
    reply = next;
    const result = await runtime.callTool('apiosk_ask', args);
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.view, 'conversation');
    assert.equal(result.structuredContent.kind, next.kind);
    assert.deepEqual(result.structuredContent.task_refs, [task]);
    const tool = (await runtime.listTools()).find(tool => tool.name === 'apiosk_ask');
    assert.equal(new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(result.structuredContent).valid, true);
  }
  assert.ok(requests.every(request => request.path === '/v2/ask/conversation'));
  assert.deepEqual(requests[0].body, args);
  reply = { kind: 'saved_answer', task_refs: ['00000000-0000-4000-8000-000000000456'] };
  assert.equal((await runtime.callTool('apiosk_ask', args)).isError, true);
  reply = { error: { code: 'follow_up_unavailable', message: 'Retry this follow-up.' } }; status = 503;
  assert.equal((await runtime.callTool('apiosk_ask', args)).structuredContent.error_code, 'follow_up_unavailable');
  assert.equal(requests.length, 5);
});

test('repeated scopes preserve missing local coverage and consume external rows only once', async () => {
  const request = { ...parsed, capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], name: 'Time yesterday' }] };
  const row = { slug: parsed.capabilities[0].slug, subject_id: 's1', apiosk: [], coinbase: [], coinbase_status: 'pending' };
  const payload = answer({ matches: [{ ...row, apiosk: [{ name: 'Current time' }] }] }, { parsed_request: request });
  payload.searches.coinbase = { matches: [{ ...row, coinbase: [{ name: 'Today' }], coinbase_status: 'ready' }, { ...row, coinbase: [{ name: 'Yesterday' }], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(payload) });
  let result = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(result.matches.length, 2);
  assert.deepEqual(result.matches[1].apiosk, []);
  assert.deepEqual(result.matches.map(row => row.coinbase[0].name), ['Today', 'Yesterday']);
  payload.searches.coinbase.matches.pop();
  result = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.ok(result.matches.every(row => !row.coinbase.length && row.coinbase_status === 'unavailable'));
});

test('apiosk_ask searches from a question and prepares only a signed explicit selection', async () => {
  const tools = await createApioskMcpRuntime({ env }).listTools();
  const ask = tools.find(t => t.name === 'apiosk_ask');
  assert.deepEqual(ask.inputSchema, schemas.ask);
  assert.deepEqual(ask.inputSchema.required, ['question']);
  assert.equal(ask.inputSchema.properties.parsed_request.type, 'object');
  assert.equal(ask.title, 'Find and choose sources');
  assert.match(ask.description, /Searching without selections or endpoint_id is free/);
  assert.match(ask.description, /one combined price and never auto-approves/);
  assert.match(ask.description, /Legacy single endpoint_id preparation can still apply/);
  assert.equal(tools.some(t => ['apiosk_search', 'apiosk_prepare'].includes(t.name)), false);
});

test('asking sends only the question to the public Ask route and returns each endpoint input contract', async () => {
  let request;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, method: options.method, body: JSON.parse(options.body) };
    return Response.json(answer({ matches: [{ slug: 'location.time.current', query: 'q', operations: ['location.time.current'],
      apiosk: [{ origin: 'apiosk', name: 'World time', description: 'Local time', source_slug: 'worldtime', capability: 'location.time.current', endpoint_id: endpoint.endpoint_id, url: null, method: 'GET', price: '0.001100 USD', network: null, calls_30d: null, availability: 'supported', endpoint }],
      coinbase: [], coinbase_status: 'pending' }] }));
  } });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask');
  assert.equal(request.method, 'POST');
  // The public route denies unknown fields: the question and nothing else.
  assert.deepEqual(request.body, { question });
  const view = result.structuredContent;
  assert.equal(view.view, 'source_search');
  assert.deepEqual(view.parsed_request, parsed);
  assert.deepEqual(view.matches[0].apiosk[0].endpoint.inputs, endpoint.inputs);
  assert.deepEqual(view.matches[0].apiosk[0].endpoint.input_values, { 'location.city': 'Amsterdam' });
  assert.equal(view.apiosk_sources_searched, 112);
  assert.equal(view.timing, undefined);
  assert.equal(view.question, question);
  assert.match(view.notice, /Preparation of selections never approves or buys/);
});

test('asking with a chosen candidate prepares only that endpoint and returns the discover task shape', async () => {
  let request;
  const task = { protocol_version: '2', request_id: '1b2c3d4e-0000-4000-8000-000000000001', status: 'requires_approval', intent_ref: null, context_view: {}, proposal: null, result: null, billing: null, next_actions: [], state: null, errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    request = { path: new URL(url).pathname, body: JSON.parse(options.body) };
    return Response.json(task);
  } });
  const result = await runtime.callTool('apiosk_ask', { question, endpoint_id: endpoint.endpoint_id, capability: 'location.time.current', input: { 'location.city': 'Amsterdam' } });
  assert.equal(result.isError, undefined, JSON.stringify(result));
  assert.equal(request.path, '/v2/ask-v2/prepare');
  assert.deepEqual(Object.keys(request.body).sort(), ['capability', 'endpoint_id', 'input', 'question', 'request_id']);
  assert.deepEqual(request.body.input, { 'location.city': 'Amsterdam' });
  assert.equal(request.body.question, question);
  assert.equal(result.structuredContent.status, 'requires_approval');
});

test('multiple explicit sources use one manual-only prepare with the exact signed search and supplied values', async () => {
  const requests=[];
  const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{
    requests.push({path:new URL(url).pathname,body:JSON.parse(options.body)});
    return Response.json({protocol_version:'2',status:'ready',next_actions:[],errors:[],billing:{authorization_active:false}});
  }});
  const args={question,parsed_request:parsed,search_id:'signed-search',request_id:'00000000-0000-4000-8000-000000000123',selections:[
    {endpoint_id:endpoint.endpoint_id,capability:endpoint.capability,subject_id:'s1',input:{'location.city':'Amsterdam'}},
    {endpoint_id:'00000000-0000-4000-8000-000000000456',capability:'location.weather.current',subject_id:'s1',input:{'location.city':'Amsterdam','include_history':false,'limit':0}},
  ]};
  const result=await runtime.callTool('apiosk_ask',args);
  assert.equal(result.isError,undefined);
  assert.deepEqual(requests,[{path:'/v2/ask/prepare',body:args}]);
  assert.equal(result.structuredContent.billing.authorization_active,false);
  for(const invalid of [
    {question,parsed_request:parsed},
    {question,selections:args.selections},
    {...args,selections:[]},
    {...args,selections:Array(11).fill(args.selections[0])},
    {...args,endpoint_id:endpoint.endpoint_id},
    {...args,selections:[{...args.selections[0],approved:true}]},
  ])assert.equal((await runtime.callTool('apiosk_ask',invalid)).isError,true);
  assert.equal(requests.length,1,'invalid selections never reach the gateway');
});

test('cached host input schemas preserve a signed selection envelope and route it only to manual preparation', async () => {
  // The validation shape shipped in 0540e08. Cached hosts know input but strip
  // the newer top-level parsed_request/search_id/selections properties.
  const oldAsk = {type:'object',additionalProperties:false,required:['question'],properties:{
    question:{type:'string',minLength:1,maxLength:4000},endpoint_id:{type:'string',format:'uuid'},
    capability:{type:'string',minLength:1,maxLength:200},input:{type:'object',maxProperties:64},
    request_id:{type:'string',format:'uuid'},
  }};
  const selection={parsed_request:parsed,search_id:'signed-search',selections:[
    {endpoint_id:endpoint.endpoint_id,capability:endpoint.capability,subject_id:'s1',input:{'location.city':'Amsterdam'}},
    {endpoint_id:'00000000-0000-4000-8000-000000000456',capability:'location.weather.current',subject_id:'s1',input:{'location.city':'Amsterdam','include_history':false,'limit':0}},
  ]};
  const args={question,request_id:'00000000-0000-4000-8000-000000000123',input:{apiosk_source_selection_v1:selection}};
  const oldValidate=new AjvJsonSchemaValidator().getValidator(oldAsk);
  assert.equal(oldValidate(args).valid,true,'the already-installed schema accepts the complete envelope');
  const cachedArgs=Object.fromEntries(Object.entries(args).filter(([key])=>Object.hasOwn(oldAsk.properties,key)));
  assert.deepEqual(cachedArgs,args,'no selection field is lost by old top-level filtering');
  const requests=[];
  const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,options)=>{
    requests.push({path:new URL(url).pathname,body:JSON.parse(options.body)});
    return Response.json({protocol_version:'2',status:'ready',next_actions:[],errors:[],billing:{authorization_active:false}});
  }});
  const result=await runtime.callTool('apiosk_ask',cachedArgs);
  assert.equal(result.isError,undefined);
  assert.deepEqual(requests,[{path:'/v2/ask/prepare',body:{question,request_id:args.request_id,...selection}}]);
  assert.equal(result.structuredContent.billing.authorization_active,false);
  assert.deepEqual(args.input.apiosk_source_selection_v1,selection);
  assert.equal(requests[0].body.input,undefined,'the transport envelope never reaches source inputs');
  for(const invalid of [
    {...args,endpoint_id:endpoint.endpoint_id},
    {...args,capability:endpoint.capability},
    {...args,...selection},
    {...args,input:{apiosk_source_selection_v1:selection,extra:'not-a-source-input'}},
    {...args,input:{apiosk_source_selection_v1:{...selection,max_total_atomic:'1'}}},
    {...args,input:{apiosk_source_selection_v1:{...selection,approved:true}}},
    {...args,input:{apiosk_source_selection_v1:{...selection,search_id:''}}},
    {...args,input:{apiosk_source_selection_v1:{search_id:'signed-search',selections:selection.selections}}},
    {...args,input:{apiosk_source_selection_v1:{...selection,selections:[]}}},
    {...args,input:{apiosk_source_selection_v1:{...selection,selections:[{...selection.selections[0],price:'1'}]}}},
    {...args,input:{apiosk_source_selection_v1:null}},
    {...args,input:{}},
  ])assert.equal((await runtime.callTool('apiosk_ask',invalid)).isError,true,JSON.stringify(invalid));
  assert.equal(requests.length,1,'malformed or mixed envelopes never fall back to free search or legacy automatic preparation');
});

test('free search preserves its signed selection proof and original question for a restored card',async()=>{
  const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json(answer({matches:[]},{search_id:'signed-search-proof'}))});
  const result=await runtime.callTool('apiosk_ask',{question});
  assert.equal(result.structuredContent.search_id,'signed-search-proof');
  assert.equal(result.structuredContent.question,question);
  assert.deepEqual(result.structuredContent.parsed_request,parsed);
});

test('free search preserves exact signed source options in the advertised schema and both output channels',async()=>{
  const candidate={origin:'apiosk',name:'World time',source_slug:'worldtime',availability:'supported',endpoint_id:endpoint.endpoint_id,capability:endpoint.capability,endpoint};
  const signedCandidate={...candidate};delete signedCandidate.endpoint;
  const unoffered={...candidate,endpoint_id:'00000000-0000-4000-8000-000000000789',name:'Discovery match not signed for selection'};
  const options=[
    {source:signedCandidate,endpoint,subject_id:'s1',requirement:parsed.capabilities[0],input_values:{'location.city':'Amsterdam',include_history:false,limit:0},missing_inputs:['location.country'],reason:'Matches your question'},
    {source:signedCandidate,endpoint:{...endpoint,input_values:{'location.city':'Paris'}},subject_id:'s2',requirement:{...parsed.capabilities[0],subject_id:'s2'},input_values:{'location.city':'Paris'},reason:'Related records for this subject'},
  ];
  const payload=answer({matches:[{slug:parsed.capabilities[0].slug,subject_id:'s1',apiosk:[candidate,unoffered],coinbase:[],coinbase_status:'complete'}]},{search_id:'signed-search-proof',source_options:options});
  const calls=[];
  const runtime=createApioskMcpRuntime({env,fetchImpl:async(url,request)=>{calls.push({path:new URL(url).pathname,body:JSON.parse(request.body)});return Response.json(payload)}});
  const reply=await runtime.callTool('apiosk_ask',{question});
  assert.equal(reply.isError,undefined);
  assert.deepEqual(reply.structuredContent.source_options,options);
  assert.equal(reply.structuredContent.matches[0].apiosk.length,2,'discovery results stay distinct from selection eligibility');
  assert.equal(reply.structuredContent.source_options.some(option=>option.source.endpoint_id===unoffered.endpoint_id),false);
  const envelope=reply.content.find(block=>block.type==='text'&&block.text.startsWith('{'));
  assert.deepEqual(JSON.parse(envelope.text).source_options,options,'text-only hosts retain the exact signed choices');
  const tool=(await runtime.listTools()).find(tool=>tool.name==='apiosk_ask');
  assert.equal(tool.outputSchema.anyOf[0].properties.source_options.items.properties.endpoint.type,'object');
  const validated=new AjvJsonSchemaValidator().getValidator(tool.outputSchema)(reply.structuredContent);
  assert.equal(validated.valid,true,JSON.stringify(validated));
  assert.match(reply.structuredContent.notice,/supported discovery match alone is not an offered selection/);
  assert.deepEqual(calls,[{path:'/v2/ask',body:{question}}],'forwarding eligibility performs no preparation or purchase');
});

test('authoritative related choices without primary matches are not reported as no results',async()=>{
  const option={source:{origin:'apiosk',availability:'supported',endpoint_id:endpoint.endpoint_id,capability:endpoint.capability},endpoint,subject_id:'s1',requirement:parsed.capabilities[0],input_values:endpoint.input_values};
  const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json(answer({matches:[]},{search_id:'signed-related-search',source_options:[option]}))});
  const view=(await runtime.callTool('apiosk_ask',{question})).structuredContent;
  assert.deepEqual(view.source_options,[option]);
  assert.equal(view.message,undefined);
  assert.deepEqual(view.parsed_request,parsed);
});

test('source option absence and an explicitly empty signed list never infer eligibility from supported matches',async()=>{
  for(const sourceOptions of [undefined,[]]){
    const candidate={availability:'supported',endpoint_id:endpoint.endpoint_id,capability:endpoint.capability,endpoint};
    const payload=answer({matches:[{slug:parsed.capabilities[0].slug,apiosk:[candidate],coinbase:[],coinbase_status:'complete'}]},
      {search_id:'signed-search-proof',...(sourceOptions!==undefined&&{source_options:sourceOptions})});
    const runtime=createApioskMcpRuntime({env,fetchImpl:async()=>Response.json(payload)});
    const reply=await runtime.callTool('apiosk_ask',{question});
    assert.deepEqual(reply.structuredContent.source_options,sourceOptions);
    assert.equal(Object.hasOwn(reply.structuredContent,'source_options'),sourceOptions!==undefined);
    assert.equal(reply.structuredContent.matches[0].apiosk.length,1);
  }
});

test('an unusable Ask reply is reported, never shown as an empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ unexpected: true }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, true);
  assert.notEqual(result.structuredContent.message, NO_RESULTS);
});

test('a public Ask refusal keeps its code and message', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ error: { code: 'rate_limit_exceeded', message: 'Too many requests are running right now.' } }, { status: 429 }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error_code, 'rate_limit_exceeded');
  assert.equal(result.structuredContent.message, 'Too many requests are running right now.');
  assert.equal(result.structuredContent.error, undefined);
});

test('a completed empty source search has the exact no-results message', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [] }, { status: 'needs_input' })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.message, NO_RESULTS);
  assert.equal(result.structuredContent.matches[0].slug, parsed.capabilities[0].slug);
});

test('an unavailable Apiosk search is not presented as a confirmed empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ ...answer({}), searches: {}, status: 'partial', errors: [{ origin: 'apiosk', code: 'search_unavailable' }] }) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.message, 'Some sources could not be searched. Try again shortly.');
});

test('an incomplete external search is not presented as a confirmed empty result', async () => {
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [{ slug: parsed.capabilities[0].slug, apiosk: [], coinbase: [], coinbase_status: 'unavailable' }] })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.structuredContent.message, 'Some sources could not be searched. Try again shortly.');
});

test('completed Coinbase search replaces the placeholder and preserves its executable candidate', async () => {
  const candidate = { origin: 'coinbase', name: 'World time', availability: 'supported', endpoint };
  const gatewayAnswer = answer({ matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', apiosk: [], coinbase: [], coinbase_status: 'pending' }] });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', coinbase: [candidate], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.deepEqual(view.matches[0].coinbase, [candidate]);
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.equal(view.message, undefined);
});

test('a completed empty external search does not tell the host to retry a pending search', async () => {
  const gatewayAnswer = answer({ matches: [{ slug: parsed.capabilities[0].slug, apiosk: [], coinbase: [], coinbase_status: 'pending' }] });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, coinbase: [], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.equal(view.message, NO_RESULTS);
});

test('external results cannot cross subjects or conceal an origin failure', async () => {
  const request = { ...parsed, subjects: [...parsed.subjects, { ...parsed.subjects[0], id: 's2', label: 'Paris' }],
    capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], subject_id: 's2' }] };
  const gatewayAnswer = answer({ matches: request.capabilities.map(cap => ({ slug: cap.slug, subject_id: cap.subject_id, apiosk: [], coinbase: [], coinbase_status: 'pending' })) }, { parsed_request: request });
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's2', coinbase: [{ name: 'Paris time' }], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  let view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.deepEqual(view.matches[0].coinbase, []);
  assert.equal(view.matches[0].coinbase_status, 'unavailable');
  assert.equal(view.matches[1].coinbase[0].name, 'Paris time');
  delete gatewayAnswer.searches.coinbase;
  gatewayAnswer.errors = [{ origin: 'coinbase', code: 'search_unavailable' }];
  view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.ok(view.matches.every(match => match.coinbase_status === 'unavailable'));
  assert.match(view.message, /could not be searched/);
});

test('available external candidates survive an Apiosk origin outage with an honest partial-search message', async () => {
  const gatewayAnswer = answer({}, { status: 'partial', errors: [{ origin: 'apiosk', code: 'search_unavailable' }] });
  delete gatewayAnswer.searches.apiosk;
  gatewayAnswer.searches.coinbase = { matches: [{ slug: parsed.capabilities[0].slug, subject_id: 's1', coinbase: [{ name: 'World time' }], coinbase_status: 'ready' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(view.matches[0].coinbase[0].name, 'World time');
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.match(view.message, /could not be searched/);
});

test('answer instructions do not become failed external searches', async () => {
  const gatewayAnswer = answer({ matches: [{ slug: parsed.capabilities[0].slug, answer_only: true, apiosk: [], coinbase: [], coinbase_status: 'ready' }] });
  gatewayAnswer.searches.coinbase = { matches: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(gatewayAnswer) });
  const view = (await runtime.callTool('apiosk_ask', { question })).structuredContent;
  assert.equal(view.matches[0].coinbase_status, 'ready');
  assert.equal(view.message, NO_RESULTS);
});

test('preparing preserves the gateway clarification and does not imply approval without a plan', async () => {
  const task = { protocol_version: '2', status: 'needs_input', context_view: { conversation: [{ question: 'Time in a city', reply: 'Which city?' }] }, proposal: null, result: null, state: { state_ref: 'saved-task' }, next_actions: [{ kind: 'supply_input', label: 'City' }], errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(task) });
  const result = await runtime.callTool('apiosk_ask', { question, endpoint_id: endpoint.endpoint_id, input: {} });
  assert.deepEqual(result.structuredContent, task);
  assert.match(result.content.map(item => item.text).join('\n'), /actual missing detail/);
  assert.doesNotMatch(result.content.map(item => item.text).join('\n'), /card can approve/);
});

test('unsupported discovery preserves matching sources without clarification guidance', async () => {
  const task = { protocol_version: '2', status: 'unsupported', context_view: { capability_intake: { parsed_request: parsed, matches: [{ slug: parsed.capabilities[0].slug, apiosk: [{ name: 'World Time', availability: 'discovery_only' }], coinbase: [] }] } }, proposal: null, result: null, next_actions: [], state: { state_ref: 'saved-task' }, errors: [] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(task) });
  const result = await runtime.callTool('apiosk_discover', { question: 'Time in Amsterdam' });
  assert.deepEqual(result.structuredContent, task);
  const text = result.content.map(item => item.text).join('\n');
  assert.match(text, /show those sources with their actual availability/);
  assert.doesNotMatch(text, /task needs an actual missing detail|card can approve/);
});

test('a missing check remains visible when another part of the professional request has matches', async () => {
  const request = { ...parsed, capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], slug: 'company.credit.score', name: 'Credit score' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [
    { slug: 'location.time.current', apiosk: [{ availability: 'supported', endpoint_id: endpoint.endpoint_id, endpoint }], coinbase: [], coinbase_status: 'complete' },
  ] }, { parsed_request: request })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.deepEqual(result.structuredContent.matches[1], { slug: 'company.credit.score', query: 'Credit score', subject_id: 's1', apiosk: [], coinbase: [], coinbase_status: 'complete' });
  assert.match(result.structuredContent.notice, /apiosk_discover with the complete question/);
  assert.match(result.structuredContent.notice, /not necessarily the complete request/);
});

test('a match for one subject does not hide the same missing check for another subject', async () => {
  const request = { ...parsed, subjects: [...parsed.subjects, { ...parsed.subjects[0], id: 's2', label: 'Paris' }],
    capabilities: [parsed.capabilities[0], { ...parsed.capabilities[0], subject_id: 's2' }] };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(answer({ matches: [
    { slug: 'location.time.current', subject_id: 's1', apiosk: [{ availability: 'supported', endpoint_id: endpoint.endpoint_id, endpoint }], coinbase: [], coinbase_status: 'complete' },
  ] }, { parsed_request: request })) });
  const result = await runtime.callTool('apiosk_ask', { question });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.matches.length, 2);
  assert.equal(result.structuredContent.matches[1].subject_id, 's2');
  assert.deepEqual(result.structuredContent.matches[1].apiosk, []);
});
