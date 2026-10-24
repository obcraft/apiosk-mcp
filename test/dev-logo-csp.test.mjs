import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createDevApp } from '../dev/host.mjs';
import { cardResources, SOURCE_LOGO_ORIGINS } from '../src/card-ui.mjs';

test('the real tester response permits every card logo origin through its inherited srcdoc CSP', async () => {
  const config = { origin: 'http://127.0.0.1:0', port: 0, mcpUrl: 'http://127.0.0.1:1/mcp',
    publicDir: fileURLToPath(new URL('../dev/public', import.meta.url)), bearer: '', modelKey: '', defaultModel: 'test' };
  const host = createDevApp(config, { connectionFactory: () => ({ snapshot: () => ({ status: 'disconnected' }), disconnect: async () => {} }) });
  const server = host.app.listen(0, '127.0.0.1');
  try {
    await once(server, 'listening'); config.port = server.address().port; config.origin = `http://127.0.0.1:${config.port}`;
    const response = await fetch(config.origin);
    assert.equal(response.status, 200);
    const policy = new Map(response.headers.get('content-security-policy').split(';').map(part => {
      const [directive, ...values] = part.trim().split(/\s+/); return [directive, values];
    }));
    // A child srcdoc policy intersects this inherited header. Allowing images
    // only in resource metadata can never override a parent self-only rule.
    const parentImages = policy.get('img-src');
    assert.deepEqual(new Set(parentImages), new Set(["'self'", 'data:', ...SOURCE_LOGO_ORIGINS]));
    for (const resource of cardResources('https://api.apiosk.com')) {
      const childImages = resource._meta.ui.csp.resourceDomains;
      for (const origin of childImages) assert.ok(parentImages.includes(origin), `${resource.mimeType}: parent blocks ${origin}`);
      assert.deepEqual(resource._meta['openai/widgetCSP'].resource_domains, childImages);
    }
    assert.ok(parentImages.includes('https://api.apiosk.com'));
    assert.ok(parentImages.includes('https://app.apiosk.com'));
    assert.ok(!parentImages.includes('*'));
    assert.ok(!parentImages.includes('https:'));
    assert.deepEqual(policy.get('connect-src'), ["'self'"]);
    assert.deepEqual(policy.get('frame-src'), ["'self'", 'blob:']);
    assert.deepEqual(policy.get('object-src'), ["'none'"]);
    assert.deepEqual(policy.get('base-uri'), ["'none'"]);
    await response.arrayBuffer();
  } finally {
    await host.close();
    await new Promise(resolve => server.close(resolve));
  }
});
