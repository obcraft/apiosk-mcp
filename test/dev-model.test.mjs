import test from 'node:test';
import assert from 'node:assert/strict';
import { completion, listModels, modelResult, modelVisible, runChat, toolForCaller } from '../dev/model.mjs';

const tool = { name: 'lookup', description: 'Read a source', inputSchema: { type: 'object' } };
const approval = { name: 'approve', inputSchema: { type: 'object' }, _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' } };
const sse = events => new Response(events.map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
const final = text => sse([{ choices: [{ delta: { content: text }, finish_reason: 'stop' }] }]);
const requestTool = name => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name, arguments: '{"query":' } }] } }] },
  { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ASML"}' } }] }, finish_reason: 'tool_calls' }] }]);

test('the model and manual inspector cannot call card-only tools', () => {
  assert.equal(modelVisible(approval), false);
  assert.throws(() => toolForCaller([approval], 'approve', 'model'), /only inside/);
  assert.throws(() => toolForCaller([approval], 'approve', 'manual'), /only inside/);
  assert.equal(toolForCaller([approval], 'approve', 'card'), approval);
  assert.throws(() => toolForCaller([tool], 'invented', 'model'), /Unknown/);
});

test('fragmented tool calls execute once and results continue the real model loop without host-only metadata', async () => {
  const requests = [], calls = [], events = [], history = [];
  const connection = { tools: [tool, approval], instructions: 'Use verified evidence.', async callTool(name, args) {
    calls.push({ name, args }); return { structuredContent: { answer: 42 }, _meta: { secret: 'host-only' } };
  } };
  await runChat({ connection, history, message: 'Look up ASML', model: 'fixture/model', key: 'fixture-key', emit: event => events.push(event),
    fetchImpl: async (url, options) => { requests.push(JSON.parse(options.body)); return requests.length === 1 ? requestTool('lookup') : final('Found it.'); } });
  assert.deepEqual(calls, [{ name: 'lookup', args: { query: 'ASML' } }]);
  assert.deepEqual(requests[0].tools.map(item => item.function.name), ['lookup']);
  assert.equal('parallel_tool_calls' in requests[0], false, 'do not require a parameter absent from tool-capable endpoints');
  assert.match(requests[0].messages[0].content, /Use verified evidence/);
  const result = requests[1].messages.find(item => item.role === 'tool');
  assert.equal(result.tool_call_id, 'call_1'); assert.match(result.content, /42/); assert.doesNotMatch(result.content, /host-only/);
  assert.equal(events.filter(event => event.type === 'tool_result').length, 1);
  assert.equal(history.at(-1).content, 'Found it.');
});

test('guessed private calls return an error to the model and never reach MCP', async () => {
  let turns = 0, executions = 0;
  const history = [];
  await runChat({ connection: { tools: [approval], callTool() { executions++; } }, history, message: 'Approve', model: 'fixture', key: 'key', emit() {},
    fetchImpl: async () => ++turns === 1 ? requestTool('approve') : final('Use the card.') });
  assert.equal(executions, 0); assert.match(history[2].content, /only inside/);
});

test('truncated streams never dispatch a partial tool call', async () => {
  let calls = 0;
  await assert.rejects(runChat({ connection: { tools: [tool], callTool() { calls++; } }, history: [], message: 'Test', model: 'fixture', key: 'key', emit() {},
    fetchImpl: async () => sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'partial', function: { name: 'lookup', arguments: '{' } }] } }] }]) }), /before completion/);
  assert.equal(calls, 0);
});

test('Stop retains the completed in-flight result without starting another model turn', async () => {
  const controller = new AbortController(), history = [];
  let modelCalls = 0;
  await assert.rejects(runChat({ connection: { tools: [tool], async callTool() { controller.abort(); return { structuredContent: { saved: true } }; } },
    history, message: 'Test', model: 'fixture', key: 'key', emit() {}, signal: controller.signal,
    fetchImpl: async () => { modelCalls++; return requestTool('lookup'); } }), /abort/i);
  assert.equal(modelCalls, 1); assert.equal(history.at(-1).role, 'tool'); assert.match(history.at(-1).content, /saved/);
});

test('card context joins the next turn as data and model catalog excludes unsupported tools', async () => {
  const pendingContext = [{ role: 'user', content: 'Updated card data: saved report' }];
  let messages;
  await runChat({ connection: { tools: [] }, history: [], pendingContext, message: 'Summarize', model: 'fixture', key: 'key', emit() {},
    fetchImpl: async (url, options) => { messages = JSON.parse(options.body).messages; return final('Summary'); } });
  assert.match(messages.at(-1).content, /Updated card/); assert.equal(pendingContext.length, 0);
  const catalog = await listModels({ fetchImpl: async () => Response.json({ data: [
    { id: 'text-only', supported_parameters: [] }, { id: 'tool-model', name: 'Tools', supported_parameters: ['tools'] },
  ] }) });
  assert.deepEqual(catalog.map(item => item.id), ['tool-model']);
  assert.doesNotMatch(modelResult({ content: [], _meta: { secret: 'hidden' } }), /hidden/);
});

test('provider failures do not expose raw bodies or credentials', async () => {
  await assert.rejects(completion({ key: 'secret-key', model: 'fixture', messages: [], tools: [],
    fetchImpl: async () => new Response('secret-key raw provider detail', { status: 401 }) }), error => /HTTP 401/.test(error.message) && !error.message.includes('secret-key'));
});

const askTools = ['apiosk_ask', 'apiosk_sources', 'apiosk_capabilities', 'apiosk_prepare', 'apiosk_approve', 'apiosk_follow_up', 'apiosk_action_execute']
  .map(name => ({ name, inputSchema: { type: 'object' } }));
const foundSources = { structuredContent: { request_id: 'saved-ask-1', status: 'sources_ready', sources: [{ name: 'Official company register', source_id: 'source-1' }] }, _meta: { private: 'host-only' } };

test('the first question reaches real Ask unchanged before the model can answer', async () => {
  const order = [], calls = [], requests = [], events = [], history = [];
  const question = 'What does ASML do? Include its registered company details.';
  await runChat({ connection: { tools: askTools }, history, message: question, model: 'fixture', key: 'key',
    emit: event => events.push(event),
    invokeTool: async (name, args, source) => { order.push('mcp'); calls.push({ name, args, source }); return foundSources; },
    fetchImpl: async (_url, options) => { order.push('model'); requests.push(JSON.parse(options.body)); return final('Review the Official company register source.'); } });
  assert.deepEqual(order, ['mcp', 'model']);
  assert.deepEqual(calls, [{ name: 'apiosk_ask', args: { question, mode: 'sources' }, source: 'model' }]);
  assert.deepEqual(requests[0].tools.map(item => item.function.name), ['apiosk_sources', 'apiosk_capabilities']);
  assert.match(requests[0].messages.find(item => item.role === 'tool').content, /Official company register/);
  assert.doesNotMatch(JSON.stringify(requests[0]), /host-only/);
  assert.match(requests[0].messages[0].content, /Do not prepare, select or purchase/);
  assert.doesNotMatch(requests[0].messages[0].content, /cards are displayed automatically/);
  assert.equal(events[0].type, 'status');
  assert.equal(events.filter(event => event.type === 'tool_start').length, 1);
  assert.equal(events.find(event => event.type === 'tool_result').result, foundSources);
});

test('initial source review cannot prepare or approve even when the model guesses a hidden call', async () => {
  for (const prohibited of ['apiosk_prepare', 'apiosk_approve', 'apiosk_action_execute', 'apiosk_ask']) {
    const calls = [], history = []; let turns = 0;
    await runChat({ connection: { tools: askTools, async callTool(name) { calls.push(name); return foundSources; } },
      history, message: 'What does ASML do?', model: 'fixture', key: 'key', emit() {},
      fetchImpl: async () => ++turns === 1 ? requestTool(prohibited) : final('Please choose a matched source.') });
    assert.deepEqual(calls, ['apiosk_ask'], prohibited);
    assert.match(history.find(item => item.role === 'tool' && item.tool_call_id === 'call_1').content, /Review the matched sources first/);
  }
});

test('discovery failure is retained and cannot turn into an unsupported model answer', async () => {
  for (const result of [
    { isError: true, content: [{ type: 'text', text: 'Gateway unavailable' }] },
    { structuredContent: { request_id: 'saved-failure', status: 'search_failed', error: { code: 'gateway_unavailable' } } },
  ]) {
    const history = [], events = []; let modelCalls = 0;
    await assert.rejects(runChat({ connection: { tools: askTools, async callTool() { return result; } }, history,
      message: 'What does ASML do?', model: 'fixture', key: 'key', emit: event => events.push(event),
      fetchImpl: async () => { modelCalls++; return final('Unsourced ASML summary'); } }), /could not finish source discovery/);
    assert.equal(modelCalls, 0);
    assert.equal(history.at(-1).role, 'tool');
    assert.equal(events.at(-1).result, result);
  }
});

test('follow-up questions keep the saved request and do not restart initial discovery', async () => {
  const history = [], calls = [];
  const connection = { tools: askTools, async callTool(name, args) { calls.push({ name, args }); return foundSources; } };
  await runChat({ connection, history, message: 'What does ASML do?', model: 'fixture', key: 'key', emit() {}, fetchImpl: async () => final('Choose a source.') });
  let turns = 0;
  await runChat({ connection, history, message: 'Explain the source coverage.', model: 'fixture', key: 'key', emit() {},
    fetchImpl: async () => ++turns === 1 ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'follow-up', function: { name: 'apiosk_follow_up', arguments: JSON.stringify({ request_id: 'saved-ask-1', question: 'Explain the source coverage.' }) } }] }, finish_reason: 'tool_calls' }] }]) : final('Here is the saved coverage.') });
  assert.deepEqual(calls.map(call => call.name), ['apiosk_ask', 'apiosk_follow_up']);
  assert.equal(calls[1].args.request_id, 'saved-ask-1');
});

test('stopping initial discovery retains its returned request without asking the model', async () => {
  const controller = new AbortController(), history = [];
  let modelCalls = 0;
  await assert.rejects(runChat({ connection: { tools: askTools, async callTool() { controller.abort(); return foundSources; } },
    history, message: 'What does ASML do?', model: 'fixture', key: 'key', emit() {}, signal: controller.signal,
    fetchImpl: async () => { modelCalls++; return final('Never returned'); } }), /abort/i);
  assert.equal(modelCalls, 0);
  assert.match(history.at(-1).content, /saved-ask-1/);
});
