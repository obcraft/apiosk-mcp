import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';

const env = {
  APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082',
  APIOSK_CONNECT_TOKEN: 'fixture',
};

// The gateway pauses named workflows (Pre-KYB Screening and the dossiers), so
// discovery offers only a question: Apiosk decides which sources it needs.
test('discovery offers no paused workflow and refuses one before the gateway', async () => {
  let calls = 0;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => { calls++; } });
  const discover = (await runtime.listTools()).find((tool) => tool.name === 'apiosk_discover');
  assert.equal(discover.inputSchema.properties.workflow, undefined);
  for (const slug of ['pre-kyb-screening', 'european-company-dossier', 'tender-company-dossier']) {
    const result = await runtime.callTool('apiosk_discover', {
      workflow: { slug, input: { name: 'Example B.V.', country: 'NL', registration: '12345678', screening_level: 'Standard' } },
    });
    assert.equal(result.structuredContent.error_code, 'invalid_arguments');
  }
  assert.equal(calls, 0);
});
