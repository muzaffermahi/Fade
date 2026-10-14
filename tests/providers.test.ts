import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { InteractiveMode, ModelRuntime, SettingsManager, createBashTool } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type Model, type Api } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { PiAgents } from '../src/pi.js';
import { terminalText } from '../src/terminal-text.js';

const tick = () => new Promise<void>(resolve => setTimeout(resolve, 10));
async function until(check: () => boolean) {
  for (let n = 0; n < 500 && !check(); n++) await tick();
  assert.ok(check(), 'boundary reached within five seconds');
}
class TestTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
async function fixture(baseUrl = 'http://127.0.0.1:1/v1', deadline = 5000, retry = false, compaction = false) {
  process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-provider-'))); store.lock();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerProvider('fixture-http', { baseUrl, api: 'openai-completions', authHeader: true, models: [{ id: 'fixture', name: 'Synthetic HTTP fixture',
    reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  await modelRuntime.setRuntimeApiKey('fixture-http', 'synthetic-never-external');
  const bridge = await createFadeRuntime(store, { providerTurnDeadlineMs: deadline }, (_s, _state, _options, converse) => ({
    build: async () => { throw new Error('No implementation in provider fixture'); },
    converse: (...args) => { assert.ok(converse); return converse(...args); }, close() {},
  }), { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: 'fixture-http', defaultModel: 'fixture',
    compaction: { enabled: compaction, reserveTokens: 1024, keepRecentTokens: 256 }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 100, provider: { maxRetries: 0 } } }) });
  const terminal = new TestTerminal(), mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await until(() => !!bridge.workspaceView);
  const root = bridge.workspaceView; assert.ok(root);
  root.view.mode = 'companion'; root.view.focus = 'companion';
  return { ...bridge, store, root, terminal, screen: () => terminalText(root.render(120).join('\n'), 500000),
    close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}
function message(model: Model<Api>, stopReason: AssistantMessage['stopReason'] = 'stop', text = 'Synthetic answer', errorMessage?: string): AssistantMessage {
  return { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: text ? [{ type: 'text', text }] : [], stopReason,
    timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...(errorMessage ? { errorMessage } : {}) };
}
function response(model: Model<Api>, failed?: string) {
  const stream = createAssistantMessageEventStream(), value = message(model, failed ? 'error' : 'stop', failed ? '' : 'Synthetic answer', failed);
  stream.push({ type: 'start', partial: value });
  if (failed) stream.push({ type: 'error', reason: 'error', error: value }); else stream.push({ type: 'done', reason: 'stop', message: value });
  return stream;
}
function success(res: ServerResponse, text = 'Synthetic answer') {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })
    + '\n\ndata: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
}

test('G21/G28/G56 F-INPUT/F-TUI F23: real SDK HTTP faults and auth expiry retain one receipt and visible recovery without automatic retries', async () => {
  let fault = 'success', requests = 0;
  const server = createServer((_request, res) => {
    requests++;
    if (fault === 'success') { success(res); return; }
    if (fault === 'empty' || fault === 'malformed') {
      res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(fault === 'empty' ? 'data: [DONE]\n\n' : 'data: {not-json}\n\n'); return;
    }
    const status = fault === 'context' ? 400 : Number(fault);
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: fault === 'context' ? 'maximum context length exceeded' : `Synthetic HTTP ${status}`, type: 'fixture' } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(`http://127.0.0.1:${address.port}/v1`);
  try {
    await f.app.submit('Inspect before authentication expires'); assert.equal(f.app.coordinator?.state.inputs.at(-1)?.status, 'processed');
    for (const current of ['401', '403', '429', '500', '503', 'malformed', 'empty', 'context']) {
      fault = current; const previous = requests, count: number = f.app.coordinator?.state.inputs.length ?? 0;
      await f.app.submit(`Inspect synthetic fault ${current}`);
      const receipt = f.app.coordinator?.state.inputs.at(-1); assert.ok(receipt);
      assert.equal(receipt.status, 'failed'); assert.equal(receipt.attempts, 1); assert.equal(requests, previous + 1);
      assert.equal(f.app.coordinator?.state.inputs.length, count + 1); assert.equal(f.runtime.session.isIdle, true);
      assert.match(f.screen(), /failed|error|Error|HTTP|empty|JSON|context/); assert.match(f.screen(), /inputs|retry-input|diagnostics/);
      assert.equal(f.app.coordinator?.state.slices.length, 0);
      writeFileSync(join(f.store.workspace, `fault-${current}.txt`), f.screen());
    }
    console.log(`F23 HTTP captures: ${f.store.workspace}`);
  } finally { await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('G56 F-OWNERSHIP F23: both production Pi adapters load valid role prompts and preserve stock tool declarations', async () => {
  const previous = process.env.PI_CODING_AGENT_DIR, directory = mkdtempSync(join(tmpdir(), 'fade-adapter-')), agentDir = join(directory, 'agent'); mkdirSync(agentDir);
  const requests: string[] = [];
  const server = createServer((request, res) => {
    let body = ''; request.setEncoding('utf8'); request.on('data', (chunk: string) => { body += chunk; }); request.on('end', () => {
      requests.push(body); success(res, JSON.stringify(requests.length === 1 ? { reply: 'Synthetic inspection', evidence: [], openQuestions: [], next: null }
        : { status: 'completed', summary: 'Synthetic adapter result; no tools executed', verification: [], discoveries: [] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  writeFileSync(join(agentDir, 'models.json'), JSON.stringify({ providers: { 'fixture-adapter': { baseUrl: `http://127.0.0.1:${address.port}/v1`, api: 'openai-completions', apiKey: 'synthetic', models: [{ id: 'fixture', name: 'Synthetic adapter', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  writeFileSync(join(agentDir, 'settings.json'), JSON.stringify({ packages: [], defaultProvider: 'fixture-adapter', defaultModel: 'fixture', retry: { enabled: false }, compaction: { enabled: false } }));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const store = new Store(join(directory, 'workspace')); store.lock(); const state = Coordinator.initial(store.workspace, 'Synthetic adapter');
  const agents = new PiAgents(store, state, { builderModel: 'fixture-adapter/fixture', companionModel: 'fixture-adapter/fixture' });
  try {
    assert.equal((await agents.converse(state, 'Inspect adapter', new AbortController().signal)).reply, 'Synthetic inspection');
    const result = await agents.build({ id: randomUUID(), status: 'running', plan: { title: 'Synthetic adapter', goal: 'Exercise SDK setup', requirements: [], decisionKeys: [], dependencies: [], assumptions: [], ready: false } }, new AbortController().signal, () => {});
    assert.equal(result.status, 'completed'); assert.equal(requests.length, 2);
    assert.match(requests[0] ?? '', /fade_role/); assert.match(requests[1] ?? '', /fade_role/);
    assert.doesNotMatch(requests[0] ?? '', /"name":"(?:bash|write|edit)"/); assert.match(requests[1] ?? '', /"name":"bash"/);
    assert.ok(state.sessions.companion); assert.equal(state.sessions.builders.length, 1);
  } finally {
    agents.close(); store.close(); if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('G56 F-INPUT F23: refused loopback connection leaves an actionable failed receipt and no stuck Pi run', async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); await new Promise<void>(resolve => server.close(() => resolve()));
  const f = await fixture(`http://127.0.0.1:${address.port}/v1`);
  try { await f.app.submit('Inspect with refused connection'); assert.equal(f.app.coordinator?.state.inputs.at(-1)?.status, 'failed'); assert.equal(f.runtime.session.isIdle, true); assert.match(f.screen(), /Connection|connect|error|failed/i); }
  finally { await f.close(); }
});

test('G28/G44 F-CONTROL F23: actual Pi interruption stays cancelling until a delayed provider quiesces and ignores late output', async () => {
  const f = await fixture(); let release = () => {}, aborted = false, calls = 0;
  f.runtime.session.agent.streamFunction = (model, _context, options) => {
    calls++; const stream = createAssistantMessageEventStream(), value = message(model);
    stream.push({ type: 'start', partial: value });
    options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    release = () => stream.push({ type: 'error', reason: 'aborted', error: { ...value, stopReason: 'aborted' } }); return stream;
  };
  try {
    const task = f.app.submit('Inspect until interrupted'); await until(() => calls === 1);
    await f.runtime.session.prompt('Retained follow-up must not replay', { streamingBehavior: 'followUp' });
    let stopped = false; const stop = f.app.interrupt().then(() => { stopped = true; }); await until(() => aborted);
    assert.equal(stopped, false); assert.equal(f.app.activity.get('companion').state, 'cancelling'); assert.match(f.screen(), /cancelling|Waiting for active work to stop/);
    assert.equal(f.app.coordinator?.state.inputs.find(input => input.text === 'Inspect until interrupted')?.status, 'processing');
    f.app.activity.observe('companion', { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'LATE UNSAFE DISPLAY' }] } });
    assert.doesNotMatch(f.screen(), /LATE UNSAFE DISPLAY/);
    release(); await stop; await task; assert.equal(f.runtime.session.isIdle, true); assert.equal(calls, 1);
    assert.equal(f.runtime.session.getFollowUpMessages().length, 0, 'interrupted accepted queues cannot silently replay');
    assert.equal(f.app.coordinator?.state.inputs.find(input => input.text === 'Retained follow-up must not replay')?.status, 'interrupted');
    assert.equal(f.app.coordinator?.state.inputs.find(input => input.text === 'Inspect until interrupted')?.status, 'interrupted'); assert.equal(f.app.activity.get('companion').state, 'paused');
  } finally { release(); await f.close(); }
});

test('G27/G44 F-CONTROL F23: provider deadline requests cancellation visibly and waits for real Pi settlement', async () => {
  const f = await fixture(undefined, 100); let release = () => {}, aborted = false;
  f.runtime.session.agent.streamFunction = (model, _context, options) => {
    const stream = createAssistantMessageEventStream(), value = message(model); stream.push({ type: 'start', partial: value });
    options?.signal?.addEventListener('abort', () => { aborted = true; }, { once: true });
    release = () => stream.push({ type: 'error', reason: 'aborted', error: { ...value, stopReason: 'aborted' } }); return stream;
  };
  try {
    let settled = false; const task = f.app.submit('Inspect deadline fixture').then(() => { settled = true; }); await until(() => aborted);
    assert.equal(settled, false); assert.equal(f.app.activity.get('companion').state, 'cancelling'); assert.match(f.screen(), /cancelling|Waiting for active work to stop/);
    release(); await task; assert.equal(f.runtime.session.isIdle, true); assert.match(f.app.coordinator?.state.inputs.at(-1)?.error ?? '', /deadline/);
    assert.match(f.screen(), /deadline|uncertain/);
  } finally { release(); await f.close(); }
});

test('G33/G44 F-INPUT F23: mixed queues retain foreign objects and block interrupted Fade replay until explicit native clearance', async () => {
  const f = await fixture(); let release = () => {}, calls = 0;
  f.runtime.session.agent.followUpMode = 'all';
  f.runtime.session.agent.streamFunction = model => {
    if (++calls > 1) return response(model);
    const stream = createAssistantMessageEventStream(), value = message(model); stream.push({ type: 'start', partial: value });
    release = () => stream.push({ type: 'error', reason: 'aborted', error: { ...value, stopReason: 'aborted' } }); return stream;
  };
  const foreign = { role: 'user' as const, content: [{ type: 'text' as const, text: 'Foreign original' }, { type: 'image' as const, mimeType: 'image/png', data: 'foreign-bytes' }], timestamp: 1 };
  try {
    const task = f.app.submit('Inspect mixed queue'); await until(() => calls === 1);
    await f.runtime.session.prompt('Interrupted owned follow-up', { streamingBehavior: 'followUp' }); f.runtime.session.agent.followUp(foreign);
    const queued = f.runtime.session.agent.peekQueuedMessages(); const stop = f.app.interrupt(); release(); await stop; await task;
    assert.deepEqual(f.runtime.session.agent.peekQueuedMessages(), queued); assert.ok(f.runtime.session.agent.peekQueuedMessages().includes(foreign));
    await f.app.submit('New prompt must not replay'); assert.equal(calls, 1); assert.match(f.app.coordinator?.state.inputs.at(-1)?.error ?? '', /mixed Pi queue/);
    f.runtime.session.clearQueue(); await f.app.submit('Explicitly cleared queue'); assert.equal(calls, 2); assert.equal(f.app.coordinator?.state.inputs.at(-1)?.status, 'processed');
    assert.equal(f.app.coordinator?.state.inputs.find(input => input.text === 'Interrupted owned follow-up')?.status, 'interrupted');
  } finally { release(); await f.close(); }
});

test('G28/G56 F-TUI F23: actual Pi context overflow compacts visibly through HTTP and retries the same receipt', async () => {
  let summaries = 0;
  const server = createServer((_request, res) => { summaries++; setTimeout(() => success(res), 100); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
  const f = await fixture(`http://127.0.0.1:${address.port}/v1`, 5000, false, true); let calls = 0, visible = false;
  const off = f.app.activity.subscribe(() => { if (/Compacting/.test(f.app.activity.get('companion').phase)) visible ||= /Compacting/.test(f.screen()); });
  try {
  const model = f.runtime.session.model; assert.ok(model);
  for (let n = 0; n < 12; n++) {
    const value = { role: 'user' as const, content: 'Synthetic old context '.repeat(200), timestamp: n };
    f.runtime.session.agent.state.messages = [...f.runtime.session.agent.state.messages, value]; f.runtime.session.sessionManager.appendMessage(value);
    const answer = message(model, 'stop', 'Synthetic old answer '.repeat(100));
    f.runtime.session.agent.state.messages = [...f.runtime.session.agent.state.messages, answer]; f.runtime.session.sessionManager.appendMessage(answer);
  }
  f.runtime.session.agent.streamFunction = (model, context, options) => ++calls === 1 ? response(model, 'maximum context length exceeded') : f.runtime.services.modelRuntime.streamSimple(model, context, options);
    await f.app.submit('Inspect overflow fixture'); assert.ok(calls >= 2); assert.ok(summaries >= 1); assert.equal(visible, true);
    assert.equal(f.app.coordinator?.state.inputs.length, 1); assert.equal(f.app.coordinator?.state.inputs[0]?.status, 'processed'); assert.equal(f.runtime.session.isIdle, true);
  } finally { off(); await f.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('G28/G56 F-TUI F23: stock Pi retry is visible, retains the same receipt and succeeds without resubmission', async () => {
  const f = await fixture(undefined, 5000, true); let calls = 0, visible = false;
  const off = f.app.activity.subscribe(() => { if (/Provider retry/.test(f.app.activity.get('companion').phase)) visible ||= /Provider retry/.test(f.screen()); });
  f.runtime.session.agent.streamFunction = model => response(model, ++calls === 1 ? '429 rate limit exceeded' : undefined);
  try {
    await f.app.submit('Inspect retry fixture'); assert.equal(calls, 2); assert.equal(visible, true); assert.equal(f.app.coordinator?.state.inputs.length, 1);
    assert.equal(f.app.coordinator?.state.inputs[0]?.attempts, 1); assert.equal(f.app.coordinator?.state.inputs[0]?.status, 'processed'); assert.equal(f.runtime.session.isIdle, true);
  } finally { off(); await f.close(); }
});

test('G44 F-OWNERSHIP/F-CONTROL F23: stock Bash cancellation stops an actual child before coordinator ownership transfers', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-tool-cancel-'))); store.lock();
  const script = join(store.workspace, 'heartbeat.cjs'), heartbeat = join(store.workspace, 'heartbeat.txt');
  writeFileSync(script, "const fs = require('node:fs'); fs.writeFileSync('pid.txt', String(process.pid)); setInterval(() => fs.appendFileSync('heartbeat.txt', 'x'), 30);");
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Synthetic cancellation'), store, {
    converse: async (_state, text) => ({ reply: 'Synthetic brief', evidence: [{ key: 'request', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
      title: 'Tool cancellation', goal: text, requirements: [text], decisionKeys: ['request'], acceptanceChecks: ['Inspect stopped process'], dependencies: [], assumptions: [], ready: true } }),
    build: async (_slice, signal) => { await createBashTool(store.workspace).execute('fixture', { command: 'node heartbeat.cjs' }, signal); throw new Error('Expected interruption'); }, close() {},
  });
  try {
    await c.talk('Implement the synthetic cancellation fixture'); await until(() => existsSync(heartbeat));
    const pid = Number(readFileSync(join(store.workspace, 'pid.txt'), 'utf8')); assert.ok(Number.isSafeInteger(pid));
    await c.withCompanionExecution('Synthetic human inspection', async () => {
      assert.equal(c.activity.get('builder').state, 'paused'); assert.throws(() => process.kill(pid, 0), /ESRCH/);
      const before = readFileSync(heartbeat, 'utf8'); await new Promise<void>(resolve => setTimeout(resolve, 100)); assert.equal(readFileSync(heartbeat, 'utf8'), before);
    });
    assert.equal(c.state.ownership.owner, null); assert.equal(c.state.slices[0]?.status, 'interrupted');
  } finally { await c.close(); }
});
