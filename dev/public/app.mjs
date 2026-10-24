import { mountCard } from './card-host.mjs';
import { renderMarkdown } from './markdown.mjs';

const $ = id => document.getElementById(id);
const state = { config: null, session: {}, models: [], selectedModel: '', cards: new Set(), tools: [], toolRows: new Map(),
  chatBusy: false, toolBusy: false, activeCardCalls: 0, connectBusy: false, resetting: false, assistant: null, controller: null,
  poll: null, toast: null, traces: 0, generation: 0, pendingMessages: [], serverBusy: false, stopping: false, chatDone: null,
  serverTracesSeen: new Set(), traceEpoch: 0 };
const narrow = matchMedia('(max-width: 1180px)');
const colorScheme = matchMedia('(prefers-color-scheme: dark)');
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
const pretty = value => JSON.stringify(value, null, 2) ?? String(value);
const errorMessage = error => error?.message || 'The request could not be completed.';
function redact(value, depth = 0) {
  if (depth > 12) return '[nested value]';
  if (Array.isArray(value)) return value.map(item => redact(item, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /authorization|bearer|(^|_)token|secret|api.?key|password|signature/i.test(key) ? '[redacted]' : redact(item, depth + 1)]));
  return value;
}
async function api(path, body, options = {}) {
  const response = await fetch(path, { ...options, ...(body !== undefined ? {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Dev-CSRF': state.config?.csrfToken || '' }, body: JSON.stringify(body),
  } : {}) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}
function toast(message) {
  clearTimeout(state.toast);
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  state.toast = setTimeout(() => $('toast').classList.add('hidden'), 6000);
}
function activity(message, kind = '') {
  $('activity-text').textContent = message;
  $('activity').className = `activity ${kind}`;
}
function scrollConversation(force = false) {
  const conversation = $('conversation');
  if (force || conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 220) {
    requestAnimationFrame(() => { conversation.scrollTop = conversation.scrollHeight; });
  }
}
function trace(event) {
  const type = event.type || event.method || event.direction || 'event';
  const entry = node('details', `trace-entry ${String(event.type || '').replace(/[^a-z_]/g, '')}`);
  const summary = node('summary');
  const icon = node('span', 'trace-icon', type === 'error' ? '!' : type === 'tool_result' ? '✓' : type === 'tool_start' ? '↗' : '↔');
  const copy = node('span', 'trace-copy');
  const at = event.at ? new Date(event.at) : new Date();
  const time = Number.isNaN(at.getTime()) ? new Date() : at;
  const metadata = [event.direction || type, event.status, event.durationMs !== undefined ? `${event.durationMs} ms` : undefined].filter(value => value !== undefined);
  copy.append(node('span', 'trace-title', event.name || event.method || (type === 'status' ? event.message : type.replaceAll('_', ' '))),
    node('span', 'trace-time', `${time.toLocaleTimeString([], { hour12: false })} · ${metadata.join(' · ')}`));
  summary.append(icon, copy);
  const serialized = pretty(redact(event));
  entry.append(summary, node('pre', '', serialized.length > 100_000 ? `${serialized.slice(0, 100_000)}\n[Preview truncated]` : serialized));
  $('trace-empty').classList.add('hidden');
  $('trace-list').prepend(entry);
  state.traces += 1;
  $('trace-count').textContent = state.traces;
  // Keep the inspector responsive during long streaming sessions.
  while ($('trace-list').childElementCount > 150) $('trace-list').lastElementChild.remove();
}
function clearTrace() {
  state.traceEpoch += 1;
  $('trace-list').replaceChildren();
  $('trace-empty').classList.remove('hidden');
  state.traces = 0;
  $('trace-count').textContent = '0';
}
async function syncConnectionTrace() {
  const generation = state.generation, epoch = state.traceEpoch;
  try {
    const response = await api('/api/trace');
    if (generation !== state.generation) return;
    for (const event of Array.isArray(response.events) ? response.events : []) {
      const key = JSON.stringify([event.at, event.method, event.direction, event.status]);
      if (state.serverTracesSeen.has(key)) continue;
      state.serverTracesSeen.add(key);
      // A pending read must not restore entries the person just cleared.
      if (epoch === state.traceEpoch) trace({ type: 'protocol', ...event });
    }
  } catch { /* Optional diagnostics never interrupt connection or sign-in. */ }
}
function showTab(tab) {
  for (const name of ['activity', 'tools']) {
    $(`${name}-tab`).classList.toggle('active', tab === name);
    $(`${name}-tab`).setAttribute('aria-selected', String(tab === name));
    $(`${name}-panel`).classList.toggle('hidden', tab !== name);
  }
  $('clear-trace').classList.toggle('hidden', tab !== 'activity');
}
function setInspector(open) {
  document.body.classList.toggle('trace-closed', !open);
  $('trace-toggle').setAttribute('aria-expanded', String(open));
  if (open && matchMedia('(max-width: 780px)').matches) {
    document.body.classList.remove('settings-open');
    $('settings-toggle').setAttribute('aria-expanded', 'false');
  }
}
function modelVisible(tool) {
  const visibility = tool?._meta?.ui?.visibility;
  return tool?._meta?.['openai/visibility'] !== 'private' && (!Array.isArray(visibility) || visibility.includes('model'));
}
function renderTools() {
  $('tools-list').replaceChildren();
  $('tool-select').replaceChildren();
  $('tools-count').textContent = state.tools.length;
  $('tools-empty').classList.toggle('hidden', state.tools.length > 0);
  const exposed = state.tools.filter(modelVisible);
  $('tool-form').classList.toggle('hidden', !exposed.length);
  for (const tool of state.tools) {
    const visible = modelVisible(tool);
    const details = node('details', 'tool-definition');
    const summary = node('summary');
    summary.append(node('span', '', tool.name), node('span', 'tool-access', visible ? 'Model + app' : 'Card only'));
    details.append(summary, node('p', '', tool.description || 'No description provided.'), node('pre', '', pretty(tool.inputSchema || {})));
    if (visible) {
      const option = node('option', '', tool.name);
      option.value = tool.name;
      $('tool-select').append(option);
      const use = node('button', 'button secondary', 'Use this tool');
      use.type = 'button';
      use.addEventListener('click', () => {
        $('tool-select').value = tool.name;
        $('tool-arguments').value = '{}';
        $('tool-form').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        $('tool-arguments').focus();
      });
      details.append(use);
    }
    $('tools-list').append(details);
  }
  updateControls();
}
function renderModels() {
  const query = $('model-search').value.trim().toLowerCase();
  const models = state.models.filter(model => `${model.name} ${model.id}`.toLowerCase().includes(query));
  $('model-select').replaceChildren();
  if (!models.length) {
    const option = node('option', '', state.models.length ? 'No matching models' : 'No models available');
    option.value = '';
    $('model-select').append(option);
  }
  for (const model of models) {
    const option = node('option', '', model.name || model.id);
    option.value = model.id;
    option.title = model.id;
    $('model-select').append(option);
  }
  if (models.some(model => model.id === state.selectedModel)) $('model-select').value = state.selectedModel;
  else $('model-select').value = '';
  $('model-label').textContent = state.models.find(model => model.id === state.selectedModel)?.name || state.selectedModel || 'No model selected';
  updateControls();
}
function updateControls() {
  const connected = Boolean(state.session.connected);
  const busy = state.chatBusy || state.serverBusy;
  const cardBusy = state.activeCardCalls > 0;
  const ready = connected && state.config?.modelConfigured && state.selectedModel && !busy && !cardBusy && !state.toolBusy && !state.resetting;
  $('send').disabled = !ready || !$('message').value.trim();
  $('message').disabled = state.resetting;
  $('stop').classList.toggle('hidden', !busy);
  $('stop').disabled = state.stopping;
  $('send').classList.toggle('hidden', busy);
  $('connect').disabled = state.connectBusy || !state.config || busy || cardBusy || state.toolBusy;
  $('disconnect').disabled = state.connectBusy || busy || cardBusy || state.toolBusy;
  $('run-tool').disabled = !connected || state.toolBusy || busy || cardBusy || state.resetting;
  $('model-select').disabled = busy || cardBusy;
  $('new-chat').disabled = state.resetting || state.toolBusy || cardBusy;
  $('composer-context').textContent = !connected ? 'Connect to start a conversation'
    : !state.config?.modelConfigured ? 'Configure a model API key to chat · direct tools are available'
    : state.stopping ? 'Stopping the model · in-flight tool results are retained'
    : cardBusy ? 'An interactive card is waiting for a tool response'
    : busy ? 'Your model is working with Apiosk' : `${$('host-mode').selectedOptions[0].textContent} · ${state.tools.filter(modelVisible).length} model-visible tools`;
}
function renderSession(session = {}) {
  const wasConnected = state.session.connected;
  state.session = session;
  state.tools = Array.isArray(session.tools) ? session.tools : [];
  const connected = Boolean(session.connected);
  $('empty-footnote').textContent = connected ? 'Sources appear after you ask. You review the total before execution.' : 'Connect to ask a question. Sources appear after you ask.';
  let authUrl = null;
  try {
    const url = new URL(session.authUrl);
    if (['https:', 'http:'].includes(url.protocol)) authUrl = url.href;
  } catch { /* No active sign-in URL. */ }
  const pending = !connected && Boolean(authUrl);
  $('connection-status').textContent = connected ? 'Connected' : pending ? 'Sign-in pending' : 'Offline';
  $('connection-status').className = `connection-badge ${connected ? 'connected' : pending ? 'pending' : ''}`;
  $('chat-connection').className = `subtle-badge ${connected ? 'connected' : ''}`;
  $('chat-connection').replaceChildren(node('span', 'status-dot'), document.createTextNode(connected ? 'MCP connected' : pending ? 'Sign-in pending' : 'Not connected'));
  $('connect').classList.toggle('hidden', connected);
  $('disconnect').classList.toggle('hidden', !connected);
  $('connect').textContent = pending ? 'Restart connection' : 'Connect to Apiosk';
  $('sign-in').classList.toggle('hidden', !pending);
  if (pending) $('sign-in').href = authUrl;
  else $('sign-in').removeAttribute('href');
  const info = session.serverInfo;
  $('connection-detail').textContent = session.error || (connected
    ? `${info?.name || 'Apiosk'}${info?.version ? ` · ${info.version}` : ''} · ${state.tools.length} tools`
    : pending ? 'Complete sign-in in the new tab. This page will reconnect automatically.' : 'Connect securely with your account, or use a session token.');
  $('connection-detail').classList.toggle('error-text', Boolean(session.error));
  renderTools();
  clearTimeout(state.poll);
  if (pending) state.poll = setTimeout(refreshConfig, 1800);
  if (connected && !wasConnected) activity('Connected. Ready for your first message.');
}
async function refreshConfig() {
  try {
    const config = await api('/api/config');
    state.config = config;
    state.serverBusy = Boolean(config.busy) && !state.chatBusy;
    $('server-url').value = config.mcpUrl || '';
    $('model-hint').textContent = config.modelConfigured ? 'Model calls use your configured OpenRouter account.'
      : 'Set OPENROUTER_API_KEY in mcp/.env.dev.local, then restart this host. You can still test tools directly.';
    $('model-hint').classList.toggle('error-text', !config.modelConfigured);
    if (!state.selectedModel && config.defaultModel) state.selectedModel = config.defaultModel;
    renderSession(config.session);
    if (state.serverBusy) {
      activity('A chat is already running in this browser session.', 'busy');
      clearTimeout(state.poll);
      state.poll = setTimeout(refreshConfig, 1500);
    }
    if (!config.busy) void flushCardMessages();
    await syncConnectionTrace();
    return config;
  } catch (error) {
    $('connection-detail').textContent = errorMessage(error);
    $('connection-detail').classList.add('error-text');
    if (state.session.authUrl && !state.session.connected) state.poll = setTimeout(refreshConfig, 4000);
    return null;
  }
}
function addMessage(role, text = '') {
  $('empty-state').classList.add('hidden');
  const article = node('article', `message ${role}`);
  const main = node('div', 'message-main');
  const heading = node('div', 'message-label', role === 'user' ? 'You' : role === 'error' ? 'Playground' : 'Apiosk');
  const time = node('time', '', new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  time.dateTime = new Date().toISOString();
  heading.append(time);
  const content = node('div', 'message-content', text);
  main.append(heading, content);
  article.append(node('div', 'message-avatar', role === 'user' ? 'Y' : role === 'error' ? '!' : 'a'), main);
  $('conversation').append(article);
  scrollConversation(true);
  return { article, main, content };
}
function toolRow(event) {
  const key = event.id || `${event.name}-${crypto.randomUUID()}`;
  if (state.toolRows.has(key)) return state.toolRows.get(key);
  const message = addMessage('assistant');
  message.content.remove();
  const box = node('div', 'tool-message');
  const header = node('div', 'tool-message-heading');
  const status = node('span', 'tool-state running', 'Running');
  header.append(node('span', '', '↗'), node('strong', '', event.name || 'MCP tool'), status);
  box.append(header);
  message.main.append(box);
  const row = { ...message, box, status, key };
  state.toolRows.set(key, row);
  return row;
}
async function callCardTool(name, args) {
  if (state.resetting || state.connectBusy || !state.session.connected) throw new Error('This chat is being reset or disconnected. Wait for the connection to be ready.');
  // Keep the host controls locked until the complete response reaches the
  // bridge. Stop affects the model only; independent card polling can continue.
  state.activeCardCalls += 1;
  updateControls();
  trace({ type: 'tool_start', direction: 'card → server', name, arguments: args });
  try {
    const response = await api('/api/tool', { name, arguments: args, source: 'card' });
    trace({ type: 'tool_result', direction: 'server → card', name, result: response.result });
    return response.result;
  } catch (error) {
    trace({ type: 'error', name, message: errorMessage(error) });
    throw error;
  } finally {
    state.activeCardCalls -= 1;
    updateControls();
    if (!state.activeCardCalls) void flushCardMessages();
  }
}
async function showToolResult(event) {
  const generation = state.generation;
  const row = toolRow(event);
  row.status.textContent = event.result?.isError ? 'Error' : 'Complete';
  row.status.className = `tool-state ${event.result?.isError ? 'failed' : 'complete'}`;
  const result = event.result || {};
  const tool = state.tools.find(tool => tool.name === event.name);
  const mode = $('host-mode').value;
  const uri = mode === 'chatgpt' ? tool?._meta?.['openai/outputTemplate'] : tool?._meta?.ui?.resourceUri;
  const raw = node('details', 'raw-result');
  raw.append(node('summary', '', 'Tool response'), node('pre', '', pretty(redact(result))));
  if (!uri) {
    row.box.append(raw);
    const text = (result.content || []).filter(content => content.type === 'text').map(content => content.text).join('\n\n');
    if (text) row.box.insertBefore(node('div', 'tool-result', text), raw);
    else raw.open = true;
    scrollConversation(true);
    return;
  }
  const container = node('div', 'card-container');
  const loading = node('div', 'tool-result', 'Loading interactive card…');
  container.append(loading);
  row.box.append(container);
  if (result.isError) row.box.append(raw);
  try {
    const resource = await api('/api/resource', { uri });
    if (generation !== state.generation) return;
    const contents = resource.contents || resource.result?.contents;
    if (!contents?.length) throw new Error('The MCP server returned an empty card resource.');
    trace({ type: 'resource', method: 'resources/read', uri, mimeType: contents[0].mimeType });
    container.replaceChildren();
    const mounted = await mountCard({ container, resource: contents[0], tool, input: event.arguments || {}, result, mode,
      theme: document.documentElement.dataset.theme,
      callTool: callCardTool,
      onMessage: sendCardMessage,
      onContext: (params, details) => api('/api/context', { ...(params?.content !== undefined ? { content: params.content } : {}),
        ...(details?.kind !== 'widget-state' && params?.structuredContent !== undefined ? { structuredContent: params.structuredContent } : {}) }),
      onTrace: trace });
    if (generation !== state.generation) mounted.destroy();
    else state.cards.add(mounted);
  } catch (error) {
    container.replaceChildren(node('div', 'tool-result error-text', `The interactive card could not load: ${errorMessage(error)}`));
    row.box.append(raw);
    raw.open = true;
    trace({ type: 'error', method: 'resources/read', uri, message: errorMessage(error) });
  }
  scrollConversation(true);
}
async function chatEvent(event) {
  switch (event.type) {
    case 'status': activity(event.message, 'busy'); trace(event); break;
    case 'assistant_delta':
      if (!state.assistant) state.assistant = addMessage('assistant');
      state.assistant.content.textContent += event.text || '';
      scrollConversation();
      break;
    case 'assistant':
      if (!state.assistant) state.assistant = addMessage('assistant');
      renderMarkdown(state.assistant.content, event.text || '');
      trace({ type: 'assistant', text: event.text });
      state.assistant = null;
      scrollConversation();
      break;
    case 'tool_start':
      state.assistant = null;
      activity(`Calling ${event.name}…`, 'busy');
      toolRow(event); trace(event); break;
    case 'tool_result':
      state.assistant = null;
      trace(event); await showToolResult(event); break;
    case 'error':
      addMessage('error', event.message || 'The model request failed.');
      activity(event.message || 'Request failed', 'error'); trace(event); break;
    case 'done': trace({ type: 'done', message: 'Model turn finished' }); break;
    default: trace(event);
  }
}
async function sendChat(text) {
  const message = String(text ?? $('message').value);
  if (!message.trim()) return;
  if (state.chatBusy || state.serverBusy || state.toolBusy || state.activeCardCalls || state.resetting) { toast('Wait for the current request to finish. Stopping the model keeps in-flight tool responses available.'); return; }
  if (!state.session.connected) { toast('Connect to Apiosk before sending a message.'); return; }
  if (!state.config?.modelConfigured || !state.selectedModel) { toast('Configure a model API key and choose a model. Direct tool testing is available in the inspector.'); return; }
  if (message.length > 16000) { toast('Keep your message within 16,000 characters.'); return; }
  state.chatBusy = true;
  state.stopping = false;
  let finishChat;
  state.chatDone = new Promise(resolve => { finishChat = resolve; });
  state.assistant = null;
  state.controller = new AbortController();
  const controller = state.controller;
  const generation = state.generation;
  $('message').value = '';
  $('message').style.height = '';
  addMessage('user', message);
  activity('Waiting for the model…', 'busy');
  updateControls();
  let errorShown = false;
  try {
    const response = await fetch('/api/chat', { method: 'POST', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', 'X-Dev-CSRF': state.config.csrfToken },
      body: JSON.stringify({ message, model: state.selectedModel }) });
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || `Chat failed (${response.status}).`);
    }
    if (!response.body) throw new Error('The server did not return a response stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const consume = async line => {
      if (!line.trim() || generation !== state.generation) return;
      const event = JSON.parse(line);
      if (event.type === 'error') errorShown = true;
      await chatEvent(event);
    };
    while (true) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        await consume(line);
      }
      if (done) { if (buffer.trim()) await consume(buffer); break; }
    }
    if (!errorShown && !controller.signal.aborted) activity(state.stopping ? 'Stopped. Your tool results remain available.' : 'Ready for your next message');
  } catch (error) {
    if (error.name !== 'AbortError' && generation === state.generation) {
      addMessage('error', errorMessage(error));
      activity(errorMessage(error), 'error');
      trace({ type: 'error', message: errorMessage(error) });
    }
  } finally {
    if (state.controller === controller) {
      state.chatBusy = false;
      state.serverBusy = false;
      state.stopping = false;
      state.controller = null;
      state.assistant = null;
      updateControls();
    }
    finishChat();
    void flushCardMessages();
  }
}
async function sendCardMessage(text) {
  const message = String(text || '');
  if (!message.trim() || message.length > 16000) throw new Error('The card follow-up must contain 1 to 16,000 characters.');
  if (!state.session.connected || !state.config?.modelConfigured || !state.selectedModel) throw new Error('Connect and configure a chat model to continue from this card.');
  if (state.resetting || state.stopping) throw new Error('The current chat is stopping. Send a follow-up after it finishes.');
  if (state.chatBusy || state.serverBusy || state.toolBusy || state.activeCardCalls) {
    if (state.pendingMessages.length >= 6) throw new Error('Too many pending card follow-ups. Wait for the current reply.');
    if (!state.pendingMessages.includes(message)) state.pendingMessages.push(message);
    trace({ type: 'status', message: 'Card follow-up queued until the current response finishes.' });
    return;
  }
  await sendChat(message);
}
async function flushCardMessages() {
  if (state.chatBusy || state.serverBusy || state.toolBusy || state.activeCardCalls || state.resetting || state.stopping || !state.pendingMessages.length) return;
  await sendChat(state.pendingMessages.shift());
}
async function cancelChat() {
  if (!state.chatBusy && !state.serverBusy) return;
  state.stopping = true;
  state.pendingMessages = [];
  updateControls();
  try {
    await api('/api/cancel', {});
    activity('Stopping the model. Waiting for any in-flight tool result…', 'busy');
    trace({ type: 'status', message: 'Stop requested; retaining any in-flight tool result.' });
    if (!state.chatBusy) {
      await waitForServerIdle();
      state.serverBusy = false; state.stopping = false; updateControls();
      activity('Stopped. Your tool results remain available.');
    }
  } catch (error) { state.stopping = false; updateControls(); toast(errorMessage(error)); throw error; }
}
async function waitForServerIdle() {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const config = await api('/api/config');
    if (!config.busy && !state.activeCardCalls && !state.toolBusy) return;
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error('A tool is still finishing. Its server-side operation has not been cancelled. Try again when the result arrives.');
}
async function resetChat() {
  if (state.resetting || state.toolBusy) return;
  state.resetting = true;
  updateControls();
  try {
    state.pendingMessages = [];
    if (state.chatBusy || state.serverBusy) {
      const pending = state.chatDone;
      await cancelChat();
      if (state.chatBusy && pending) await pending;
      await waitForServerIdle();
    }
    if (state.activeCardCalls) await waitForServerIdle();
    await api('/api/reset', {});
    state.generation += 1;
    for (const card of state.cards) card.destroy();
    state.cards.clear(); state.toolRows.clear(); state.assistant = null;
    for (const message of $('conversation').querySelectorAll('.message')) message.remove();
    $('empty-state').classList.remove('hidden');
    clearTrace();
    state.serverTracesSeen.clear();
    activity('New chat. Ready when you are.');
    $('message').value = '';
    $('message').style.height = '';
  } catch (error) { toast(errorMessage(error)); }
  finally { state.resetting = false; updateControls(); $('message').focus(); }
}
function applyTheme() {
  const theme = $('theme').value === 'system' ? colorScheme.matches ? 'dark' : 'light' : $('theme').value;
  document.documentElement.dataset.theme = theme;
  for (const card of state.cards) card.setTheme(theme);
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void sendChat(); });
$('message').addEventListener('input', () => {
  $('message').style.height = 'auto';
  $('message').style.height = `${Math.min(200, $('message').scrollHeight)}px`;
  updateControls();
});
$('message').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void sendChat(); }
});
for (const suggestion of document.querySelectorAll('[data-message]')) suggestion.addEventListener('click', () => void sendChat(suggestion.dataset.message));
$('stop').addEventListener('click', () => { void cancelChat().catch(() => {}); });
$('new-chat').addEventListener('click', () => void resetChat());
$('clear-trace').addEventListener('click', clearTrace);
$('trace-toggle').addEventListener('click', () => setInspector(document.body.classList.contains('trace-closed')));
$('settings-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('settings-open');
  $('settings-toggle').setAttribute('aria-expanded', String(open));
  if (open) setInspector(false);
});
$('activity-tab').addEventListener('click', () => showTab('activity'));
$('tools-tab').addEventListener('click', () => showTab('tools'));
$('model-search').addEventListener('input', renderModels);
$('model-select').addEventListener('change', () => {
  state.selectedModel = $('model-select').value;
  $('model-label').textContent = $('model-select').selectedOptions[0]?.textContent || 'No model selected';
  updateControls();
});
$('theme').addEventListener('change', applyTheme);
colorScheme.addEventListener('change', applyTheme);
$('host-mode').addEventListener('change', () => { updateControls(); toast('Host mode changed. New cards will use this bridge.'); });
$('connect').addEventListener('click', async () => {
  if (state.activeCardCalls || state.toolBusy || state.chatBusy || state.serverBusy || state.resetting || state.connectBusy) return;
  state.connectBusy = true; updateControls(); activity('Connecting to the MCP server…', 'busy');
  const token = $('access-token').value.trim();
  $('access-token').value = '';
  try {
    const session = await api('/api/connect', token ? { token } : {});
    renderSession(session.session || session);
    trace({ type: 'connection', connected: state.session.connected, serverInfo: state.session.serverInfo, toolCount: state.tools.length });
    if (!state.session.connected) activity(state.session.authUrl ? 'Continue sign-in to connect your account.' : state.session.error || 'Connection pending');
  } catch (error) {
    activity(errorMessage(error), 'error');
    $('connection-detail').textContent = errorMessage(error);
    $('connection-detail').classList.add('error-text');
  } finally { await syncConnectionTrace(); state.connectBusy = false; updateControls(); }
});
$('disconnect').addEventListener('click', async () => {
  if (state.activeCardCalls || state.toolBusy || state.chatBusy || state.serverBusy || state.resetting || state.connectBusy) return;
  state.connectBusy = true; updateControls();
  try {
    await api('/api/disconnect', {});
    clearTimeout(state.poll);
    renderSession({ connected: false });
    for (const card of state.cards) card.destroy();
    state.cards.clear(); state.pendingMessages = [];
    for (const container of document.querySelectorAll('.card-container')) container.replaceChildren(node('div', 'tool-result', 'Disconnected. The saved response is available in the Inspector.'));
    activity('Disconnected. Connect again to use tools.');
    trace({ type: 'connection', connected: false });
  } catch (error) { toast(errorMessage(error)); }
  finally { state.connectBusy = false; updateControls(); }
});
$('tool-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (state.toolBusy || state.chatBusy || state.serverBusy || state.activeCardCalls || state.resetting || !state.session.connected) return;
  const name = $('tool-select').value;
  const tool = state.tools.find(tool => tool.name === name && modelVisible(tool));
  if (!tool) return;
  let args;
  try {
    args = JSON.parse($('tool-arguments').value);
    if (!args || Array.isArray(args) || typeof args !== 'object') throw new Error('Arguments must be a JSON object.');
  } catch (error) { $('tool-error').textContent = errorMessage(error); return; }
  $('tool-error').textContent = '';
  const id = crypto.randomUUID();
  state.toolBusy = true; updateControls();
  activity(`Calling ${name} directly…`, 'busy');
  const start = { type: 'tool_start', id, name, arguments: args, source: 'manual' };
  toolRow(start); trace(start);
  try {
    const response = await api('/api/tool', { name, arguments: args, source: 'manual' });
    const result = { type: 'tool_result', id, name, arguments: args, result: response.result };
    trace(result); await showToolResult(result);
    activity(response.result?.isError ? 'The tool returned an error. Inspect its response.' : 'Tool complete. Response saved in the conversation.', response.result?.isError ? 'error' : '');
  } catch (error) {
    const row = state.toolRows.get(id);
    row.status.textContent = 'Error'; row.status.className = 'tool-state failed';
    row.box.append(node('div', 'tool-result error-text', errorMessage(error)));
    $('tool-error').textContent = errorMessage(error);
    trace({ type: 'error', id, name, message: errorMessage(error) });
    activity(errorMessage(error), 'error');
  } finally { state.toolBusy = false; updateControls(); void flushCardMessages(); }
});
window.addEventListener('focus', () => { if (state.session.authUrl && !state.session.connected) void refreshConfig(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { setInspector(false); document.body.classList.remove('settings-open'); $('settings-toggle').setAttribute('aria-expanded', 'false'); }
});
setInspector(!narrow.matches);
applyTheme();
const config = await refreshConfig();
try {
  const response = await api('/api/models');
  state.models = Array.isArray(response.models) ? response.models : [];
  state.selectedModel = response.defaultModel || config?.defaultModel || state.models[0]?.id || '';
  if (state.selectedModel && !state.models.some(model => model.id === state.selectedModel)) state.models.unshift({ id: state.selectedModel, name: state.selectedModel });
  renderModels();
} catch (error) {
  $('model-hint').textContent = `Models could not load: ${errorMessage(error)}. You can still call tools directly.`;
  $('model-hint').classList.add('error-text');
  if (config?.defaultModel) { state.models = [{ id: config.defaultModel, name: config.defaultModel }]; state.selectedModel = config.defaultModel; }
  renderModels();
}
