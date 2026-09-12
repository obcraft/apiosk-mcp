import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { V2_CARD_ACTIONS } from '../src/gateway-v2-card-actions.mjs';

function harness(callTool = async () => { throw new Error('Unexpected tool call'); }) {
  let now = Date.parse('2026-09-12T16:00:00Z'), timerId = 0;
  const timers = new Map(), calls = [], feedback = [];
  const element = (_tag, _class, textContent = '') => ({ textContent, disabled: false, children: [], append(...items) { this.children.push(...items); } });
  const context = vm.createContext({
    Date: class extends Date { static now() { return now; } },
    window: { apiosk: { async callTool(name, args) { calls.push({ name, args }); return callTool(name, args); } } },
    el: element, money: value => value, section: element, sections: element(), actionButton: element,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    showFeedback(message) { feedback.push(message); },
  });
  vm.runInContext(`let output=null,busy=false,watchUntil=0,pollTimer=null,planSurface=null;const attempted=new Set();
    function render(data){output=data;planSurface=el();renderActions(data)}
    function acceptResponse(data){render(data)}
    ${V2_CARD_ACTIONS}
    globalThis.show=render;globalThis.current=()=>output;globalThis.buttons=()=>planSurface.children.flatMap(w=>w.children);`, context);
  return { context, calls, feedback, timers, advance(ms) { now += ms; }, show: data => context.show(data), buttons: () => context.buttons() };
}
const plan = () => ({
  status: 'ready', state: { state_ref: 'task', revision: 1 },
  proposal: { quote_ref: 'quote', max_total_atomic: '239131', currency: 'USD', expires_at: '2026-09-12T16:00:01Z', approval_url: 'https://app.apiosk.com/gateway-v2?task=task' },
  billing: { authorization_active: false, executions: [] },
  context_view: { approval_mode: 'chatbot', conversation: [{ question: 'Original complete research question and PDF' }] },
  next_actions: [{ kind: 'execute_quoted_step', action_id: 'run' }],
});

test('a quote that expires while the card is open becomes visibly expired without buying', () => {
  const h = harness(); h.show(plan());
  assert.equal(h.buttons()[0].disabled, false);
  const timer = [...h.timers.values()].find(t => t.ms === 1001);
  assert.ok(timer); h.advance(1001); timer.fn();
  assert.ok(h.buttons().some(b => b.textContent === 'Get new price' && !b.disabled));
  assert.ok(h.buttons().some(b => b.textContent.startsWith('Quote expired') && b.disabled));
  assert.match(h.feedback.at(-1), /expired/); assert.equal(h.calls.length, 0);
});

test('an approval click after expiry gives feedback even when browser timers were suspended', async () => {
  const h = harness(); h.show(plan()); const button = h.buttons()[0];
  h.advance(2000); await button.onclick();
  assert.match(h.feedback.at(-1), /Click Get new price/);
  assert.equal(h.calls.length, 0);
});

test('refresh recovers current state and re-quotes the original question without approving it', async () => {
  const old = plan(), fresh = { ...old, state: { state_ref: 'task', revision: 3, state_token: 'fresh' } };
  const renewed = { ...fresh, proposal: { ...old.proposal, quote_ref: 'new', max_total_atomic: '250000', expires_at: '2026-09-12T16:10:00Z' } };
  const h = harness(async name => name === 'apiosk_status' ? fresh : renewed);
  h.advance(2000); h.show(old);
  await h.buttons().find(b => b.textContent === 'Get new price').onclick();
  assert.deepEqual(h.calls.map(c => c.name), ['apiosk_status', 'apiosk_discover']);
  assert.equal(h.calls[1].args.state.state_token, 'fresh');
  assert.equal(h.calls[1].args.question, old.context_view.conversation[0].question);
  assert.equal(h.context.current().proposal.quote_ref, 'new');
  assert.match(h.feedback.at(-1), /Review the plan and click Approve/);
});

test('refresh never replaces a plan another card approved or already executed', async () => {
  for (const billing of [{ authorization_active: true }, { authorization_active: false, executions: [{ status: 'captured' }] }]) {
    const old = plan(), h = harness(async () => ({ ...old, billing }));
    h.advance(2000); h.show(old); await h.buttons().find(b => b.textContent === 'Get new price').onclick();
    assert.deepEqual(h.calls.map(c => c.name), ['apiosk_status']);
  }
});

test('refresh failure stays visible and the user can retry', async () => {
  const h = harness(async () => { throw new Error('Connection interrupted'); });
  h.advance(2000); h.show(plan()); const button = h.buttons().find(b => b.textContent === 'Get new price');
  await button.onclick(); assert.match(h.feedback.at(-1), /Connection interrupted/); assert.equal(button.disabled, false);
  await button.onclick(); assert.equal(h.calls.length, 2);
});
