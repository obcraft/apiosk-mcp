import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAskService } from '../src/service.mjs';
import { withEmbeddedCards } from '../src/card-adapter.mjs';
import { GatewayClient } from '../src/gateway.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
export const QUESTIONS = [
  'KYB check for Mollie B.V. (KVK number 30204462): show the registered company profile and screen the company name against sanctions lists.',
  'What does ASML do?',
];

// Evaluate the actual frozen App's pure display functions, not a second MCP
// implementation. Nothing from the App's auth, network or component tree runs.
export async function loadAppProjection(appDirectory = resolve(here, '../../app')) {
  const paths = {
    page: 'src/components/ask-v2/ask-v2-page.tsx',
    summary: 'src/lib/domain/source-summary.ts',
    purchase: 'src/lib/domain/ask-v2-purchase.ts',
    chats: 'src/lib/domain/ask-v2-chats.ts',
  };
  const files = Object.fromEntries(await Promise.all(Object.entries(paths).map(async ([key, path]) => [key, await readFile(resolve(appDirectory, path), 'utf8')])));
  const fn = (text, name) => {
    const found = text.match(new RegExp(`^(?:export )?function ${name}\\([^]*?^}`, 'm'));
    assert.ok(found, `The frozen App function ${name} was not found; update the acceptance loader explicitly.`);
    return found[0].replace(/^export /, '');
  };
  const source = [fn(files.purchase, 'purchaseInputKey'), fn(files.purchase, 'sourceRef'),
    fn(files.chats, 'safeSourceUrl'), fn(files.chats, 'sourceItemKey'),
    files.summary.replace(/^import .*$/gm, '').replace(/^export /gm, ''), fn(files.page, 'sourceRows')].join('\n');
  const js = stripTypeScriptTypes(source, { mode: 'strip' });
  const api = new Function(`${js}\nreturn {sourceRows,sourceItemKey,sourceSummary};`)();
  return { ...api, source_sha256: sha(source), files: Object.values(paths) };
}

function memoryStore() {
  const states = new Map();
  return {
    async create(value) { const state = { ...value, id: randomUUID() }; states.set(state.id, state); return state; },
    async save(value) { states.set(value.id, value); },
    async get(id) { return states.get(id); },
    async list() { return [...states.values()]; },
    async withLock(_id, run) { return run(); },
  };
}

/** One discovery only. A live response is never saved to disk by this script. */
export async function verifyDiscoveryParity({ question, capture, client, app }) {
  let discovery = capture?.discovery || capture;
  question ||= discovery?.question || capture?.question;
  assert.equal(typeof question, 'string', 'A question is required.');
  const routes = [];
  const allowed = new Set(['/v2/ask/page', '/v2/ask-v2/parse', '/v2/ask-v2/search']);
  const gateway = {
    baseUrl: client?.baseUrl || 'https://api.apiosk.com', credentialKind: client?.credentialKind || 'connection',
    async displayContext() { return discovery?.context_view?.money_display ? { money_display: discovery.context_view.money_display } : null; },
    async request(path, options) {
      assert.ok(allowed.has(path), `Acceptance refuses unexpected route ${path}; no pricing or execution is allowed.`);
      assert.equal(options.method, 'POST');
      if (path === '/v2/ask/page') {
        assert.deepEqual(Object.keys(options.body), ['question'], 'Connected discovery must send the unchanged user question only.');
        assert.equal(options.body.question, question);
      }
      routes.push({ path, body_fields: Object.keys(options.body).sort() });
      if (client) {
        const response = await client.request(path, options);
        if (path === '/v2/ask/page') discovery = response;
        else if (path.endsWith('/parse')) discovery = { ...response, searches: {}, question };
        else discovery.searches[options.body.origin] = response;
        return response;
      }
      if (path === '/v2/ask/page') { assert.equal(options.body.question, question); return clone(discovery); }
      if (path.endsWith('/parse')) return { ...clone(discovery), searches: undefined };
      return clone(discovery.searches[options.body.origin]);
    },
  };
  const store = memoryStore();
  const service = withEmbeddedCards(createAskService({ gateway, store }), { gateway, store });
  const response = await service.tools.find(tool => tool.name === 'apiosk_ask').handler({ question });
  assert.ok(!response.isError, 'MCP discovery returned an error.');
  const state = await store.get(response.structuredContent.request_id);
  assert.ok(state?.discovery?.parsed_request, 'Discovery did not return a parsed request.');
  assert.ok(!state.discovery.errors?.length, 'Discovery returned origin errors; parity cannot be established.');
  const found = state.discovery;
  const expected = app.sourceRows({ apiosk: { data: found.searches?.apiosk }, coinbase: { data: found.searches?.coinbase } }, found.parsed_request);
  const actual = response._meta?.apiosk_card_data?.source_rows;
  assert.ok(Array.isArray(actual), 'MCP did not return its embedded source rows.');
  const signature = source => ({ key: app.sourceItemKey(source), name: source.name, origin: source.origin,
    source_slug: source.source_slug, price: source.price, summary: app.sourceSummary(source),
    subject_label: source.subject_label, availability: source.availability });
  const expectedSignatures = expected.map(row => signature(row.source));
  const actualSignatures = actual.map(signature);
  assert.equal(sha(actualSignatures), sha(expectedSignatures), 'MCP source order, identity, scope or prices differ from the actual App projection.');
  assert.equal(response.structuredContent.source_count, expected.length, 'Model and embedded source counts differ.');
  assert.equal(state.tasks.length, 0, 'Discovery created a purchase task.');
  assert.equal(state.approval ?? null, null, 'Discovery created an approval.');
  const providers = new Map();
  for (const row of expected) {
    const source = row.source;
    const key = `${source.origin}:${source.source_slug?.trim().toLowerCase() || source.name.trim().toLowerCase()}`;
    if (!providers.has(key)) providers.set(key, { name: source.name, origin: source.origin, count: 0 });
    providers.get(key).count++;
  }
  return { question, mode: client ? 'live_discovery_same_response' : 'recorded_discovery_replay', pass: true,
    parsed_request_sha256: sha(found.parsed_request), app_source_sha256: app.source_sha256,
    source_rows_sha256: sha(expectedSignatures), source_count: expected.length, provider_groups: [...providers.values()],
    routes, paid_or_prepare_calls: 0, note: client
      ? 'One live interpretation feeds both comparisons. This proves the current MCP route and display projection, not deterministic model output across independent requests or internal Gateway parser selection.'
      : 'Recorded discovery may predate the current Gateway route. Replay proves the current MCP request shape and same-response App display projection only; it does not establish live backend parity.' };
}

async function main() {
  const argv = process.argv.slice(2), captures = [];
  let live = false, reportPath, appDirectory;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--capture') captures.push(argv[++index]);
    else if (argv[index] === '--report') reportPath = argv[++index];
    else if (argv[index] === '--app') appDirectory = argv[++index];
    else if (argv[index] === '--live') live = true;
    else throw new Error('Use --capture FILE (repeatable) or --live, optionally --report FILE and --app DIRECTORY.');
  }
  assert.ok(live !== Boolean(captures.length), 'Choose recorded captures or live discovery.');
  const app = await loadAppProjection(appDirectory);
  const reports = [];
  if (live) {
    const client = new GatewayClient({ baseUrl: process.env.APIOSK_GATEWAY_URL, timeoutMs: 180_000 });
    assert.equal(client.credentialKind, 'connection', 'Live acceptance requires the existing connected MCP credential.');
    for (const question of QUESTIONS) reports.push(await verifyDiscoveryParity({ question, client, app }));
  } else for (const path of captures) reports.push(await verifyDiscoveryParity({ capture: JSON.parse(await readFile(path, 'utf8')), app }));
  const text = JSON.stringify({ checked_at: new Date().toISOString(), pass: true, cases: reports }, null, 2) + '\n';
  if (reportPath) await writeFile(reportPath, text, { mode: 0o600 });
  process.stdout.write(text);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Ask discovery acceptance failed: ${error.message}`); process.exitCode = 1; });
}
