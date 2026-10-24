import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { APIOSK_UI_BRIDGE } from '../src/ask-ui/ui-bridge.mjs';
import { withIntrinsicCardSize } from '../src/card-size.mjs';

async function mount({ chatgpt = false } = {}) {
  const messages = [], heights = [], listeners = new Map(), observed = [];
  let contentHeight = 480, viewportHeight = 1200, callback;
  const document = {
    documentElement: { clientWidth: 360, scrollWidth: 900, dataset: {}, style: {}, get scrollHeight() { return Math.max(viewportHeight, contentHeight); } },
    body: { getBoundingClientRect: () => ({ height: contentHeight }) },
  };
  const parent = { postMessage(message) { messages.push(message); } };
  const window = {
    parent, getComputedStyle: () => ({ marginTop: '4px', marginBottom: '8px' }),
    addEventListener(name, listener) { listeners.set(name, listener); },
    ...(chatgpt ? { openai: { notifyIntrinsicHeight(height) { heights.push(height); viewportHeight = height; } } } : {}),
  };
  const context = vm.createContext({ window, document, URL, setTimeout() {}, clearTimeout() {},
    requestAnimationFrame(run) { run(); }, ResizeObserver: class { constructor(run) { callback = run; } observe(node) { observed.push(node); } } });
  vm.runInContext(withIntrinsicCardSize(APIOSK_UI_BRIDGE), context);
  const initialize = messages.find(message => message.method === 'ui/initialize');
  if (!chatgpt) {
    listeners.get('message')({ source: parent, data: { jsonrpc: '2.0', id: initialize.id, result: { hostCapabilities: {} } } });
    for (let index = 0; index < 5; index++) await Promise.resolve();
  }
  return { messages, heights, observed, document, window,
    size(next) { contentHeight = next; callback(); },
    viewport(next) { viewportHeight = next; callback(); },
  };
}

test('MCP card height grows and shrinks with content without following its existing iframe viewport', async () => {
  const h = await mount();
  const sizes = () => h.messages.filter(message => message.method === 'ui/notifications/size-changed').map(message => ({ ...message.params }));
  assert.deepEqual(h.observed, [h.document.body]);
  assert.deepEqual(sizes(), [{ width: 360, height: 492 }], 'Initial handshake reports intrinsic content, not the 1200px viewport or overflowing width.');
  h.size(900); h.viewport(912); h.size(300); h.viewport(312); h.window.apiosk.resize();
  assert.deepEqual(sizes(), [{ width: 360, height: 492 }, { width: 360, height: 912 }, { width: 360, height: 312 }]);
});

test('ChatGPT card height grows and shrinks while suppressing repeated host resize notifications', async () => {
  const h = await mount({ chatgpt: true });
  h.size(900); h.viewport(912); h.size(300); h.viewport(312); h.window.apiosk.resize();
  assert.deepEqual(h.heights, [492, 912, 312]);
  assert.deepEqual(h.observed, [h.document.body]);
  assert.equal(h.messages.filter(message => message.method === 'ui/notifications/size-changed').length, 0);
});
