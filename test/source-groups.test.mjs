import test from 'node:test';
import assert from 'node:assert/strict';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js';
import { createApioskMcpRuntime } from '../src/runtime.mjs';
import { GROUPED_PROVIDERS, GROUPED_SOURCES_NOTICE, GROUPED_SOURCES_TOOL_TEXT, presentSources } from '../src/source-groups.mjs';

const env = { APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082', APIOSK_CONNECT_TOKEN: 'fixture' };

test('grouped providers mirror the gateway definition exactly', () => {
  // gateway/src/sources.rs GROUPED_PROVIDERS; the gateway groups by the stored
  // owner handle, these strings only word the chatbot contract.
  assert.deepEqual(GROUPED_PROVIDERS.map(p => ({ ...p })), [
    { handle: 'pulsenetwork', name: 'Pulse Network', description: 'Data services published by Pulse Network.', category: 'intelligence' },
    { handle: 'coinbase-bazaar', name: 'Coinbase Bazaar', description: 'Third-party pay-per-call services listed in the Coinbase x402 Bazaar. Apiosk buys each call for you from your balance.', category: 'marketplace' },
  ]);
  assert.ok(Object.isFrozen(GROUPED_PROVIDERS) && GROUPED_PROVIDERS.every(Object.isFrozen));
  for (const text of [GROUPED_SOURCES_TOOL_TEXT, GROUPED_SOURCES_NOTICE]) {
    assert.match(text, /Pulse Network and Coinbase Bazaar are each one source/);
  }
});

test('the sources tool tells every host that each grouped provider is one source', async () => {
  const tool = (await createApioskMcpRuntime({ env }).listTools()).find(t => t.name === 'apiosk_sources');
  assert.ok(tool.description.includes(GROUPED_SOURCES_TOOL_TEXT));
  assert.doesNotMatch(tool.description, /Pulse Network is one source/);
});

test('a capped Coinbase Bazaar row passes the output schema with its exact service count', async () => {
  const services = Array.from({ length: 100 }, (_, i) => ({ slug: `cbz-host-${i}`, name: `Service ${i}`, description: 'Paid lookup', category: 'data' }));
  const bazaar = { slug: 'coinbase-bazaar', provider_slug: 'coinbase-bazaar', logo_url: null, name: 'Coinbase Bazaar', description: GROUPED_PROVIDERS[1].description,
    category: 'marketplace', categories: ['marketplace'], tags: [], sectors: [], endpoint_count: 480, capabilities: [], input_types: [],
    service_count: 212, matching_service_count: 212, services, available_in_v2: true };
  const pulse = { slug: 'pulsenetwork', name: 'Pulse Network', service_count: 87, services: [{ slug: 'tax-pulse', name: 'TaxPulse' }], available_in_v2: false };
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json({ protocol_version: '2', sources: [bazaar, pulse], total: 2, catalog_total: 40, offset: 0, next_offset: null, categories: ['marketplace'], tags: [], sectors: [], capabilities: [], notice: 'internal' }) });
  const tool = (await runtime.listTools()).find(t => t.name === 'apiosk_sources');
  const result = await runtime.callTool('apiosk_sources', { search: 'crypto' });
  assert.equal(result.isError, undefined);
  const { structuredContent } = result;
  assert.equal(structuredContent.total, 2, 'grouped providers are counted once each');
  assert.equal(structuredContent.sources[0].service_count, 212);
  assert.equal(structuredContent.sources[0].services.length, 100);
  assert.equal(structuredContent.sources[0].available_in_v2, undefined);
  assert.equal(structuredContent.catalog_total, undefined);
  assert.ok(structuredContent.notice.includes(GROUPED_SOURCES_NOTICE));
  const validate = new AjvJsonSchemaValidator().getValidator(tool.outputSchema);
  assert.equal(validate(structuredContent).valid, true);
});

test('presentation never forwards the gateway notice or internal readiness flags', () => {
  const shown = presentSources({ protocol_version: '2', sources: [{ slug: 'x', available_in_v2: true, can_answer_questions: false }], total: 1, catalog_total: 3, notice: 'internal' });
  assert.deepEqual(shown.sources, [{ slug: 'x' }]);
  assert.equal(shown.catalog_total, undefined);
  assert.notEqual(shown.notice, 'internal');
});

test('a source page larger than a task view is read and trimmed to what hosts display', async () => {
  // Pulse Network lists every member capability: the live page passed 256 KB
  // and the whole browse failed as "temporarily unavailable".
  const capabilities = Array.from({ length: 4000 }, (_, i) => `pulse.operation_${String(i).padStart(4, '0')}.lookup`);
  const pulse = { slug: 'pulsenetwork', name: 'Pulse Network', category: 'intelligence', service_count: 916, capabilities, executable_capabilities: capabilities, input_types: ['company.name'],
    readiness: { contracts: { accepted_contracts: 916 }, coverage_notices: capabilities }, services: [{ slug: 'tax-pulse', name: 'TaxPulse', description: 'x'.repeat(900) }] };
  const page = { protocol_version: '2', sources: [pulse], total: 1, offset: 0, next_offset: null, categories: ['intelligence'], tags: capabilities, sectors: [], capabilities: [...capabilities, 'operation.hidden'], notice: 'n' };
  assert.ok(JSON.stringify(page).length > 256 * 1024);
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => Response.json(page) });
  const result = await runtime.callTool('apiosk_sources', {});
  assert.equal(result.isError, undefined);
  const [source] = result.structuredContent.sources;
  assert.equal(source.capabilities.length, 12);
  assert.equal(source.executable_capabilities, undefined);
  assert.deepEqual(source.readiness, { contracts: { accepted_contracts: 916 } });
  assert.equal(source.services[0].description.length, 120);
  assert.equal(result.structuredContent.capabilities.length, 200);
  assert.ok(!result.structuredContent.capabilities.includes('operation.hidden'));
  assert.ok(result.content[0].text.length < 64 * 1024);
});
