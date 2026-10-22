import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { APIOSK_UI_BRIDGE } from '../../src/ui-bridge.mjs';

export const flatten = node => [node.textContent, ...node.children.flatMap(flatten)];
export const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
export const plain = value => JSON.parse(JSON.stringify(value));

// Execute the shipped card scripts with the same two host transports as launch-ui.
// Timers are manual: a test can prove mounting/selecting never initiates a purchase.
export function cardHarness(html = null, openai = null) {
  const sent = [], listeners = new Map(), nodes = new Map(), timers = new Map();
  let timerId = 0;
  const element = (name = 'div') => {
    const node = {
      nodeType: 1, tagName: name.toUpperCase(), textContent: '', value: '', checked: false,
      disabled: false, dataset: {}, children: [], isConnected: true, className: '',
      get lastElementChild() { return this.children.at(-1); },
      remove() {
        if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
        this.parentElement = null;
      },
      append(...children) {
        for (const child of children) { child.remove?.(); child.parentElement = this; this.children.push(child); }
      },
      prepend(...children) {
        for (const child of [...children].reverse()) { child.remove?.(); child.parentElement = this; this.children.unshift(child); }
      },
      replaceChildren(...children) {
        for (const child of this.children) child.parentElement = null;
        this.children = []; this.append(...children);
      },
      querySelector(selector) { return this.querySelectorAll(selector)[0]; },
      querySelectorAll(selector) {
        return this.children.flatMap(child => [
          ...(selector.split(',').some(raw => {
            const part = raw.trim();
            return part.startsWith('.') ? child.className.split(' ').includes(part.slice(1)) : part === child.tagName.toLowerCase();
          }) ? [child] : []),
          ...child.querySelectorAll(selector),
        ]);
      },
      setAttribute(key, value) { this[key] = String(value); },
      getAttribute(key) { return this[key] ?? null; },
      focus() {}, after() {},
      addEventListener(event, callback) { this['on' + event] = callback; },
      reportValidity() { return !this.required || (this.type === 'checkbox' ? this.checked : this.value !== ''); },
    };
    node.classList = {
      contains(value) { return node.className.split(' ').includes(value); },
      add(...values) { node.className = [...new Set([...node.className.split(' ').filter(Boolean), ...values])].join(' '); },
      remove(...values) { node.className = node.className.split(' ').filter(value => !values.includes(value)).join(' '); },
      toggle(value, force) {
        const enabled = force === undefined ? !this.contains(value) : force;
        enabled ? this.add(value) : this.remove(value); return enabled;
      },
    };
    return node;
  };
  const document = {
    documentElement: { scrollWidth: 320, scrollHeight: 200, dataset: {}, style: {} },
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
  };
  const parent = { postMessage(message) { sent.push(message); } };
  const window = { parent, openai, crypto: webcrypto, addEventListener(event, callback) { listeners.set(event, callback); } };
  const context = vm.createContext({
    window, document, URL, Intl, console, crypto: webcrypto, EventSource: openai?.EventSource,
    setInterval(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms, repeat: true }); return id; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, ms) { const id = ++timerId; timers.set(id, { callback, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { observe() {} },
  });
  if (html) for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) vm.runInContext(script[1], context);
  else vm.runInContext(APIOSK_UI_BRIDGE, context);
  return {
    sent, nodes, window,
    async globals(globals) {
      Object.assign(window.openai, globals);
      listeners.get('openai:set_globals')?.({ detail: { globals } });
      await flush();
    },
    async tick(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      if (!entry) return false;
      if (!entry[1].repeat) timers.delete(entry[0]);
      entry[1].callback(); await flush(); return true;
    },
    async message(data, source = parent) {
      listeners.get('message')?.({ source, data }); await flush();
    },
    async initialize(hostName = 'test-host') {
      const init = sent.find(message => message.method === 'ui/initialize');
      await this.message({ jsonrpc: '2.0', id: init.id, result: {
        hostInfo: { name: hostName, version: '1' },
        hostCapabilities: { serverTools: {}, message: { text: {} }, openLinks: {}, updateModelContext: { text: {} } },
      } });
    },
    async change(node, value) {
      if (node.type === 'checkbox') node.checked = value;
      else node.value = value;
      await node.oninput?.({ target: node, currentTarget: node });
      await node.onchange?.({ target: node, currentTarget: node });
      await flush();
    },
  };
}
