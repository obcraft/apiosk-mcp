import test from 'node:test';
import assert from 'node:assert/strict';
import { createApioskMcpRuntime } from '../src/runtime.mjs';

const env = {
  APIOSK_GATEWAY_V2_URL: 'http://127.0.0.1:8082',
  APIOSK_CONNECT_TOKEN: 'fixture',
};

test('Pre-KYB Screening starts one fixed plan, preserving supplied inputs and its approval requirement', async () => {
  const calls = [];
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async (url, options) => {
    calls.push({ url, ...options });
    return Response.json({
      protocol_version: '2', status: 'requires_approval', next_actions: [], errors: [],
      context_view: { workflow: { slug: 'pre-kyb-screening', title: 'Pre-KYB Screening' } },
      proposal: { label: 'Pre-KYB Screening', max_total_atomic: '690000', currency: 'USD' },
      billing: { authorization_active: false },
    });
  } });
  const requestId = '00000000-0000-4000-8000-000000000001';
  const inputs = [
    { name: 'Example Limited', country: 'GB', screening_level: 'Standard' },
    {
      name: 'Example Limited', country: 'GB', registration: '00000001',
      domain: 'example.com', screening_level: 'Enhanced',
      vat_country: 'IE', vat_number: '1234567T', iban: 'IE29AIBK93115212345678',
    },
  ];
  for (const input of inputs) {
    const result = await runtime.callTool('apiosk_discover', {
      workflow: { slug: 'pre-kyb-screening', input }, request_id: requestId,
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'requires_approval');
    assert.equal(result.structuredContent.billing.authorization_active, false);
    assert.equal(result.structuredContent.proposal.max_total_atomic, '690000');
    assert.deepEqual(JSON.parse(calls.at(-1).body), { input, request_id: requestId });
  }
  assert.equal(calls.length, inputs.length);
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.url.pathname, '/v2/workflows/pre-kyb-screening/start');
  }
});

test('invalid Pre-KYB input and invented approval cannot reach the gateway', async () => {
  let calls = 0;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => { calls++; } });
  const workflow = { slug: 'pre-kyb-screening', input: { name: 'Example Limited', country: 'GB', screening_level: 'Standard' } };
  const invalidInputs = [
    { country: 'GB' },
    { name: 'Example Limited' },
    { name: 'Example Limited', country: 'GB' },
    { ...workflow.input, country: 'US' },
    { ...workflow.input, name: '' },
    { ...workflow.input, vat_country: 'IE' },
    { ...workflow.input, vat_number: '1234567T' },
    { ...workflow.input, vat_country: 'US', vat_number: '1234567T' },
    { ...workflow.input, screening_level: 'Complete KYB' },
    { ...workflow.input, wallet: '0x1234' },
  ];
  for (const input of invalidInputs) {
    const result = await runtime.callTool('apiosk_discover', { workflow: { ...workflow, input } });
    assert.equal(result.structuredContent.error_code, 'invalid_arguments');
  }
  for (const extra of [{ question: 'Also run this' }, { approved: true }, { context_delta: {} }]) {
    const result = await runtime.callTool('apiosk_discover', { workflow, ...extra });
    assert.equal(result.structuredContent.error_code, 'invalid_arguments');
  }
  assert.equal(calls, 0);
});

test('Pre-KYB optional registration does not weaken existing dossier requirements', async () => {
  let calls = 0;
  const runtime = createApioskMcpRuntime({ env, fetchImpl: async () => { calls++; } });
  for (const slug of ['european-company-dossier', 'tender-company-dossier']) {
    const result = await runtime.callTool('apiosk_discover', {
      workflow: { slug, input: { name: 'Example B.V.', country: 'NL' } },
    });
    assert.equal(result.structuredContent.error_code, 'invalid_arguments');
  }
  assert.equal(calls, 0);
});
