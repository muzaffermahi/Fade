import { test } from 'node:test';
import assert from 'node:assert/strict';
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]).toString('base64');
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import type { Agents } from '../src/coordinator.js';
import type { BuilderResult, CompanionReply } from '../src/contracts.js';
import { ReceiptCorrelation } from '../src/receipt-correlation.js';

const reply: CompanionReply = { reply: 'A **quiet place** gives unfinished thoughts room.', evidence: [], openQuestions: [], next: null };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function config() {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-key-never-sent');
  return { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [],
    defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } }), model };
}
async function fixture(holdConversation = false, explicitBuilder = false, native = false, suppliedStore?: Store) {
  const store = suppliedStore ?? new Store(mkdtempSync(join(tmpdir(), 'fade-tui-'))); store.lock();
  const inputs: string[] = []; let builds = 0; let finish: (() => void) | undefined;
  const configured = await config();
  const bridge = await createFadeRuntime(store, explicitBuilder ? { builderModel: `${configured.model.provider}/${configured.model.id}` } : {},
    (_store, _state, _options, converse): Agents => ({
      build: async (_slice, signal) => { builds++; return new Promise<BuilderResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }); },
      converse: async (state, text, signal, event, sourceId) => {
        inputs.push(text);
        if (native) { assert.ok(converse); return converse(state, text, signal, event, sourceId); }
        if (holdConversation && inputs.length === 1) await new Promise<void>(resolve => {
          finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return text === 'Build a quiet notebook.' ? { ...reply, evidence: [{ key: 'notebook', text: text, quote: text, kind: 'decision' }], next: {
          title: 'Notebook', goal: text, requirements: ['Quiet notebook'], acceptanceChecks: ['Run notebook checks'], decisionKeys: ['notebook'], dependencies: [], assumptions: [], ready: true,
        } } : reply;
      }, close: () => {},
    }), configured);
  await bridge.runtime.session.bindExtensions({});
  return { ...bridge, store, inputs, configured, builds: () => builds, finish: () => finish?.() };
}
async function settle(f: Awaited<ReturnType<typeof fixture>>) {
  // Builder stays active; wait only for the durable conversation queue.
  for (let i = 0; i < 500 && !f.app.coordinator?.state.conversation.some(m => m.role === 'companion'); i++) await new Promise(done => setTimeout(done, 10));
  assert.ok(f.app.coordinator?.state.conversation.some(m => m.role === 'companion'), JSON.stringify(f.runtime.session.messages));
}
function response(model: Awaited<ReturnType<typeof config>>['model'], content: AssistantMessage['content'], tools = false) {
  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content,
    stopReason: tools ? 'toolUse' : 'stop', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  stream.push({ type: 'start', partial: message });
  stream.push({ type: 'done', reason: tools ? 'toolUse' : 'stop', message }); return stream;
}

test('G33 F-INPUT: actual Pi consumes identical queued text by object identity with distinct modes, images and reply receipts', async () => {
  const f = await fixture(false, false, true); let release = () => {}; let calls = 0;
  const observedImages: string[][] = [];
  f.runtime.session.agent.streamFunction = (model, context) => {
    calls++;
    const user = context.messages.findLast(message => message.role === 'user' && (typeof message.content === 'string' ? message.content === 'Identical thought' : message.content.some(block => block.type === 'text' && block.text === 'Identical thought')));
    observedImages.push(user?.role === 'user' && typeof user.content !== 'string' ? user.content.filter(block => block.type === 'image').map(block => block.data) : []);
    if (calls > 1) return response(model, [{ type: 'text', text: `Reply ${calls}` }]);
    const stream = createAssistantMessageEventStream(); const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'Reply 1' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: message }); release = () => stream.push({ type: 'done', reason: 'stop', message }); return stream;
  };
  try {
    await f.runtime.session.prompt('Identical thought');
    for (let index = 0; index < 100 && calls === 0; index++) await tick(); assert.equal(calls, 1);
    for (const [mode, data] of [['steer', png('hello')], ['steer', png('world')], ['followUp', png('third')]] as const) {
      await f.runtime.session.prompt('Identical thought', { streamingBehavior: mode, images: [{ type: 'image', mimeType: 'image/png', data }] });
    }
    assert.deepEqual(f.runtime.session.getSteeringMessages(), ['Identical thought', 'Identical thought']); assert.deepEqual(f.runtime.session.getFollowUpMessages(), ['Identical thought']);
    const c = f.app.coordinator; assert.ok(c); const ids = c.state.inputs.map(input => input.id); assert.equal(new Set(ids).size, 4);
    release(); await f.app.idle();
    assert.equal(calls, 4); assert.deepEqual(observedImages, [[], [png('hello')], [png('world')], [png('third')]]);
    assert.ok(c.state.inputs.every(input => input.status === 'processed' && input.attempts === 1));
    const replies = c.state.conversation.filter(record => record.role === 'companion'); assert.equal(replies.length, 4);
    for (let index = 0; index < replies.length; index++) { const record = replies[index]; assert.ok(record?.scope === 'session'); assert.equal(record.receiptId, ids[index]); assert.equal(record.text, `Reply ${index + 1}`); }
    assert.deepEqual(f.store.load()?.conversation, c.state.conversation);
  } finally { release(); f.disposeView(); await f.app.close(); await f.runtime.dispose(); }
});

test('G33 F-INPUT: public correlation protects third-party identical queues and restores owned ports once', async () => {
  const f = await fixture(); const agent = f.runtime.session.agent;
  const originalSteer = agent.steer, originalFollow = agent.followUp, originalClear = agent.clearAllQueues;
  const correlation = new ReceiptCorrelation(agent);
  const first = { role: 'user', content: [{ type: 'text', text: 'Same' }, { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], timestamp: 1 } satisfies Parameters<typeof agent.steer>[0];
  const second = { ...first, content: [{ type: 'text', text: 'Same' }, { type: 'image', mimeType: 'image/png', data: 'd29ybGQ=' }] } satisfies Parameters<typeof agent.followUp>[0];
  try {
    await correlation.dispatch({ id: 'owned', sessionId: 'native', role: 'builder', mode: 'steer' }, async () => { await tick(); agent.steer(first); });
    assert.equal(correlation.allOwned(new Set(['owned'])), true); agent.followUp(second);
    assert.equal(correlation.allOwned(new Set(['owned'])), false);
    assert.deepEqual(correlation.consumed(first), { id: 'owned', sessionId: 'native', role: 'builder', mode: 'steer' });
    assert.equal(correlation.consumed(second), undefined); agent.clearAllQueues(); assert.equal(correlation.allOwned(new Set()), true);
    correlation.dispose(); correlation.dispose(); assert.equal(agent.steer, originalSteer); assert.equal(agent.followUp, originalFollow); assert.equal(agent.clearAllQueues, originalClear);
    assert.throws(() => correlation.dispatch({ id: 'later', sessionId: 'native', role: 'companion', mode: 'followUp' }, () => {}), /disposed/);
  } finally { correlation.dispose(); agent.clearAllQueues(); f.disposeView(); await f.app.close(); await f.runtime.dispose(); }
});

test('G31/G32 F-INPUT: actual Pi new/resume preserves shared intent and active Builder while selecting only destination discussion', async () => {
  const f = await fixture();
  try {
    await f.runtime.session.prompt('Build a quiet notebook.'); await settle(f);
    const c = f.app.coordinator; assert.ok(c); const oldId = f.app.currentSessionId; const oldFile = f.runtime.session.sessionManager.getSessionFile(); assert.ok(oldFile);
    // This fixture bypasses the provider; create a synthetic native assistant entry so Pi flushes its real resumable session file.
    f.runtime.session.sessionManager.appendMessage({ role: 'assistant', api: f.configured.model.api, provider: f.configured.model.provider, model: f.configured.model.id,
      content: [{ type: 'text', text: 'Synthetic native session observation' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    assert.equal(existsSync(oldFile), true);
    const intent = structuredClone(c.state.intent), slice = structuredClone(c.state.slices[0]);
    assert.equal((await f.runtime.newSession()).cancelled, false); await f.runtime.session.bindExtensions({});
    assert.notEqual(f.app.currentSessionId, oldId); assert.deepEqual(f.app.history(), []); assert.deepEqual(c.state.intent, intent); assert.deepEqual(c.state.slices[0], slice);
    assert.equal(c.state.slices[0]?.status, 'running'); assert.match(f.app.inspect('history'), /Build a quiet notebook/);
    assert.equal(f.runtime.session.messages.some(message => JSON.stringify(message).includes('quiet notebook')), false);
    await f.runtime.switchSession(oldFile); await f.runtime.session.bindExtensions({});
    assert.equal(f.app.currentSessionId, oldId); assert.ok(f.app.history().some(record => record.text === 'Build a quiet notebook.'));
    assert.deepEqual(c.state.intent, intent); assert.equal(c.state.slices[0]?.status, 'running'); assert.equal(f.builds(), 1);
  } finally { f.disposeView(); await f.app.close(); await f.runtime.dispose(); }
});

test('FADE-15: ordinary prompts automatically run Fade concurrently while preserving stock tools, shell input, and session navigation', async () => {
  const f = await fixture();
  try {
    await f.runtime.session.prompt('Build a quiet notebook.'); await settle(f);
    assert.equal(f.builds(), 1); assert.deepEqual(f.inputs, ['Build a quiet notebook.']);
    assert.equal(f.app.coordinator?.state.slices[0]?.status, 'running');
    for (const tool of ['read', 'fade_update_intent']) assert.ok(f.runtime.session.getActiveToolNames().includes(tool), tool);
    for (const tool of ['bash', 'edit', 'write']) assert.ok(!f.runtime.session.getActiveToolNames().includes(tool), tool);
    assert.equal(f.runtime.session.model?.id, f.configured.model.id);
    assert.equal(f.app.options.builderModel, `${f.configured.model.provider}/${f.configured.model.id}`);
    assert.ok(f.runtime.session.extensionRunner?.getCommand('mcp'));
    const shell = await f.runtime.session.extensionRunner?.emitUserBash({ type: 'user_bash', command: 'echo native-shell', cwd: f.store.workspace, excludeFromContext: false });
    assert.ok(shell?.operations);
    const executed = await f.runtime.session.executeBash('echo native-shell', undefined, { operations: shell.operations }); assert.match(executed.output, /native-shell/);
    await f.runtime.session.prompt('/pause'); assert.equal(f.app.coordinator?.state.mode, 'paused');
    assert.equal((await f.runtime.newSession()).cancelled, false);
  } finally { await f.app.close(); await f.runtime.dispose(); }
  assert.equal(existsSync(join(f.store.directory, 'lock')), false);
});

test('FADE-16: rapid prompts are saved before processing and remain ordered', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.session.prompt('First thought'); await tick();
    await f.runtime.session.prompt('Second thought');
    assert.deepEqual(f.store.load()?.conversation.filter(m => m.role === 'human').map(m => m.text), ['First thought', 'Second thought']);
    assert.deepEqual(f.inputs, ['First thought']); f.finish(); await tick(); await tick();
    assert.deepEqual(f.inputs, ['First thought', 'Second thought']);
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

test('F09: Companion dispatch rejects writes, shell and indirect unknown tools even during a human execution lease', async () => {
  const f = await fixture();
  try {
    await f.app.submit('Explore the current project.');
    const runner = f.runtime.session.extensionRunner; assert.ok(runner); const c = f.app.coordinator; assert.ok(c);
    for (const toolName of ['write', 'edit', 'bash', 'mcp_mutation', 'delegate', 'apply_patch']) {
      const result = await runner.emitToolCall({ type: 'tool_call', toolCallId: toolName, toolName, input: {} });
      assert.equal(result?.block, true, toolName);
      assert.ok(!f.runtime.session.getActiveToolNames().includes(toolName));
    }
    await c.withCompanionExecution('explicit human shell', async () => {
      assert.equal((await runner.emitToolCall({ type: 'tool_call', toolCallId: 'nested-write', toolName: 'write', input: { path: 'escape.txt', content: 'forbidden' } }))?.block, true);
    });
    assert.equal(existsSync(join(f.store.workspace, 'escape.txt')), false);
    assert.ok(f.runtime.session.getActiveToolNames().includes('fade_project_context'));
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

test('F-INPUT/F-TUI: native streaming preserves steering/follow-up, queue edits, cancellation and attachment receipts', async () => {
  const f = await fixture(false, false, true);
  let release: () => void = () => {}; let calls = 0;
  f.runtime.session.agent.streamFunction = (model, context) => {
    if (++calls > 1) {
      const texts = context.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(c => c.type === 'text').map(c => c.text));
      const current = texts.findLast(text => text.startsWith('Latest Fade coordinator context')); assert.ok(current);
      assert.ok(current.includes('"currentHumanMessage":"Revised steering"'), current);
      return response(model, [{ type: 'text', text: 'The revised steering entered my context.' }]);
    }
    const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id,
      content: [{ type: 'text', text: 'Thinking.' }], stopReason: 'stop', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: message });
    release = () => stream.push({ type: 'done', reason: 'stop', message }); return stream;
  };
  try {
    await f.runtime.session.prompt('Explore a future idea');
    for (let i = 0; i < 100 && !f.runtime.session.isStreaming; i++) await tick();
    assert.equal(f.runtime.session.isStreaming, true);
    await f.runtime.session.prompt('Steer this thought', { streamingBehavior: 'steer', images: [{ type: 'image', mimeType: 'image/png', data: png('hello') }] });
    await f.runtime.session.prompt('Follow up later', { streamingBehavior: 'followUp' });
    const c = f.app.coordinator; assert.ok(c);
    const steer = c.state.inputs.find(i => i.text === 'Steer this thought'); const follow = c.state.inputs.find(i => i.text === 'Follow up later'); assert.ok(steer); assert.ok(follow);
    assert.equal(steer.mode, 'steer'); assert.equal(follow.mode, 'followUp'); assert.equal(f.store.images(steer.attachments)[0]?.data, png('hello'));
    assert.deepEqual(f.runtime.session.getSteeringMessages(), ['Steer this thought']); assert.deepEqual(f.runtime.session.getFollowUpMessages(), ['Follow up later']);
    await f.runtime.session.prompt(`/edit-input ${steer.id} Revised steering`);
    await f.runtime.session.prompt(`/cancel-input ${follow.id}`);
    assert.deepEqual(f.runtime.session.getSteeringMessages(), ['Revised steering']); assert.equal(f.runtime.session.getFollowUpMessages().length, 0);
    release(); await f.app.idle();
    assert.equal(c.state.inputs.find(i => i.id === steer.id)?.status, 'processed');
    assert.equal(c.state.inputs.find(i => i.id === follow.id)?.status, 'cancelled');
    assert.equal(f.store.images(f.store.load()?.inputs.find(i => i.id === steer.id)?.attachments ?? [])[0]?.data, png('hello'));
    assert.equal(f.runtime.session.messages.some(m => m.role === 'custom' && m.customType === 'fade-context'), false);
  } finally { release(); f.disposeView(); await f.app.close(); await f.runtime.dispose(); }
});

test('FADE-17: interrupted native conversation retains accepted input and recovery stays paused', async () => {
  const f = await fixture(true);
  await f.runtime.session.prompt('First thought'); await tick();
  await f.runtime.session.prompt('A second thought worth keeping'); await f.app.close(); await f.runtime.dispose();
  assert.equal(f.store.load()?.conversation.filter(m => m.role === 'human').length, 2);
  f.store.lock();
  const restored = await createFadeRuntime(f.store, {}, () => ({ build: async () => { throw new Error('Recovery must not build'); }, converse: async () => reply, close: () => {} }), f.configured);
  try {
    await restored.runtime.session.bindExtensions({});
    assert.equal(restored.app.coordinator?.state.mode, 'paused');
    const saved = restored.app.coordinator?.state.inputs.find(input => input.text === 'A second thought worth keeping'); assert.ok(saved);
    assert.ok(restored.app.history(saved.sessionId).some(m => m.text === saved.text), 'saved provenance remains accessible in its destination session');
    assert.match(restored.app.inspect('history'), /A second thought worth keeping/);
    if (saved.sessionId !== restored.app.currentSessionId) assert.equal(restored.app.history().some(m => m.text === saved.text), false, 'a newly selected Pi session must not inherit saved discussion implicitly');
  } finally { await restored.app.close(); await restored.runtime.dispose(); }
});

test('FADE-18: model selection follows Pi without changing an explicit Builder override', async () => {
  const f = await fixture(false, true);
  try {
    const alternate = f.runtime.services.modelRuntime.getModels().find(m => m.provider !== f.configured.model.provider); assert.ok(alternate);
    await f.runtime.session.extensionRunner?.emit({ type: 'model_select', model: alternate, previousModel: f.runtime.session.model, source: 'set' });
    assert.equal(f.app.options.companionModel, `${alternate.provider}/${alternate.id}`);
    assert.equal(f.app.options.builderModel, `${f.configured.model.provider}/${f.configured.model.id}`);
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

test('FADE-19/F-OWNERSHIP: native Companion reads real files, streams tool events and records intent while implementation belongs to Builder', async () => {
  const f = await fixture(false, false, true);
  const human = 'Read essay.md and improve the draft.';
  writeFileSync(join(f.store.workspace, 'essay.md'), 'The lantern remembers the rain.');
  let calls = 0; const tools: string[] = [];
  const off = f.runtime.session.subscribe(event => { if (event.type === 'tool_execution_start') tools.push(event.toolName); });
  f.runtime.session.agent.streamFunction = (model, context) => {
    calls++;
    if (calls === 1) {
      assert.ok(context.messages.some(m => m.role === 'system' && m.toolsAdded?.some(t => t.name === 'read')));
      const declared = context.messages.flatMap(m => m.role === 'system' ? m.toolsAdded?.map(t => t.name) ?? [] : []);
      assert.ok(declared.includes('fade_update_intent'));
      assert.ok(!declared.some(name => ['write', 'edit', 'bash'].includes(name)), 'F-OWNERSHIP: provider declarations reflect the Companion lease');
      return response(model, [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'essay.md' } }], true);
    }
    if (calls === 2) {
      assert.ok(context.messages.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('lantern remembers')));
      const requests: ToolCall[] = [
        { type: 'toolCall', id: 'intent-1', name: 'fade_update_intent', arguments: { evidence: [{ key: 'writing', text: 'Improve the existing draft', quote: human, kind: 'decision' }], openQuestions: [], next: null } },
      ]; return response(model, requests, true);
    }
    return response(model, [{ type: 'text', text: 'I read the lantern sentence and recorded the requested improvement.' }]);
  };
  try {
    await f.runtime.session.prompt(human); await settle(f);
    assert.equal(calls, 3); assert.deepEqual(tools, ['read', 'fade_update_intent']);
    assert.equal(existsSync(join(f.store.workspace, 'draft.md')), false);
    assert.ok(f.app.coordinator?.state.intent.decisions.some(d => d.key === 'writing' && d.quote === human));
    assert.ok(f.runtime.session.messages.some(m => m.role === 'assistant' && JSON.stringify(m.content).includes('I read the lantern')));
    assert.equal(f.runtime.session.messages.some(m => m.role === 'custom' && m.customType === 'fade-companion'), false);
  } finally { off(); await f.app.close(); await f.runtime.dispose(); }
});

test('FADE-20: native resource discovery retains project instructions and prompt templates', async () => {
  const f = await fixture();
  try {
    mkdirSync(join(f.store.workspace, '.pi', 'prompts'), { recursive: true });
    writeFileSync(join(f.store.workspace, 'AGENTS.md'), 'Look for the paper crane before revising.');
    writeFileSync(join(f.store.workspace, '.pi', 'prompts', 'crane.md'), 'Inspect the paper crane.');
    await f.runtime.services.resourceLoader.reload();
    assert.ok(f.runtime.services.resourceLoader.getAgentsFiles().agentsFiles.some(file => file.content.includes('paper crane')));
    assert.ok(f.runtime.services.resourceLoader.getPrompts().prompts.some(prompt => prompt.name === 'crane'));
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

test('FADE-21: invalid native intent evidence is held while human input and the actual Pi response survive', async () => {
  const f = await fixture(false, false, true); let calls = 0;
  f.runtime.session.agent.streamFunction = model => {
    calls++;
    if (calls === 1) return response(model, [{ type: 'toolCall', id: 'bad-evidence', name: 'fade_update_intent', arguments: {
      evidence: [{ key: 'invented', text: 'Deploy it', quote: 'Please deploy it', kind: 'decision' }], openQuestions: [], next: null,
    } }], true);
    return response(model, [{ type: 'text', text: 'We can inspect before deciding what to change.' }]);
  };
  try {
    await f.runtime.session.prompt('Can we inspect first?');
    await settle(f);
    assert.equal(f.app.coordinator?.state.intent.decisions.length, 0);
    assert.equal(f.app.history()[0]?.text, 'Can we inspect first?');
    assert.ok(f.runtime.session.messages.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('verbatim')));
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

import { sliceReport, executionLog } from '../src/reports.js';
test('FADE-24: readable reports retain reported checks and actual tool failures without raw transport JSON', async () => {
  const f = await fixture();
  try {
    await f.runtime.session.prompt('Inspect the current draft'); await settle(f);
    await f.runtime.session.prompt('/builder What can you verify?');
    assert.equal(f.app.coordinator?.state.builderMessages?.[0]?.status, 'pending');
    await f.runtime.session.prompt('/builder');
    assert.match(f.app.inspect('builder'), /Your Builder notes/);
    const slice = { id: 'report-fixture', status: 'draft' as const, plan: { title: 'Draft improvement', goal: 'Improve the draft', requirements: [], decisionKeys: [], dependencies: [], assumptions: [], ready: false } };
    assert.match(sliceReport({ ...slice, status: 'completed', result: { status: 'completed', summary: 'Edited the draft', verification: ['node test.mjs: passed'], discoveries: [] } }), /Checks reported:[\s\S]*node test.mjs: passed/);
    const log = executionLog(JSON.stringify({ event: { event: { type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'test failed: empty input' }] } } } }));
    assert.match(log, /bash · failed/); assert.match(log, /empty input/); assert.doesNotMatch(log, /tool_execution_end/);
    const before = f.runtime.session.messages.length;
    await f.runtime.session.prompt('/reports');
    assert.equal(f.runtime.session.messages.length, before);
    assert.match(f.app.inspect('reports'), /Companion · latest reply/);
  } finally { await f.app.close(); await f.runtime.dispose(); }
});

test('F-INPUT/F-TUI: provider/context-limit failure after steering never marks the consumed input processed', async () => {
  const f = await fixture(false, false, true); let release:()=>void = ()=>{}; let calls=0;
  f.runtime.session.agent.streamFunction = model => {
    const stream=createAssistantMessageEventStream();const failed=++calls>1;
    const message:AssistantMessage={role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:failed?'':'Thinking'}],stopReason:failed?'error':'stop',timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},...(failed?{errorMessage:'Context window exceeded'}:{})};
    stream.push({type:'start',partial:message});
    if(failed)stream.push({type:'error',reason:'error',error:message});else release=()=>stream.push({type:'done',reason:'stop',message});return stream;
  };
  try {
    await f.runtime.session.prompt('Explore first');for(let i=0;i<100&&!f.runtime.session.isStreaming;i++)await tick();
    await f.runtime.session.prompt('A saved steering message',{streamingBehavior:'steer'});release();await f.app.idle();
    assert.equal(f.app.coordinator?.state.inputs.find(i=>i.text==='A saved steering message')?.status,'interrupted');
    assert.ok(f.app.coordinator?.state.inputs.some(i=>i.status==='failed')); assert.equal(calls,2);
  } finally {release();f.disposeView();await f.app.close();await f.runtime.dispose();}
});

test('F-INPUT/F-CONTINUITY: failed streaming acceptance cannot fall through into Pi without a durable receipt', async () => {
  class FailingStore extends Store {
    fail = false;
    override save(state: Parameters<Store['save']>[0]): void { if (this.fail) throw new Error('Injected disk full'); super.save(state); }
  }
  const store = new FailingStore(mkdtempSync(join(tmpdir(), 'fade-stream-storage-')));
  const f = await fixture(false, false, true, store); let release:()=>void = ()=>{};
  f.runtime.session.agent.streamFunction = model => {
    const stream = createAssistantMessageEventStream();
    const message:AssistantMessage = { role:'assistant',api:model.api,provider:model.provider,model:model.id,content:[{type:'text',text:'Thinking'}],stopReason:'stop',timestamp:Date.now(),
      usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}} };
    stream.push({type:'start',partial:message});release=()=>stream.push({type:'done',reason:'stop',message});return stream;
  };
  try {
    await f.runtime.session.prompt('Explore first');for(let i=0;i<100&&!f.runtime.session.isStreaming;i++)await tick();
    assert.ok(f.runtime.session.isStreaming);store.fail=true;
    const result=await f.runtime.session.extensionRunner?.emitInput('Unsaved steering text',undefined,'interactive','steer');
    assert.equal(result?.action,'handled','Pi must not process input after Fade rejects its durable acceptance');
    assert.equal(f.app.coordinator?.state.inputs.some(i=>i.text==='Unsaved steering text'),false);
    assert.equal(f.runtime.session.getSteeringMessages().length,0);
  } finally {store.fail=false;release();f.disposeView();await f.app.close();await f.runtime.dispose();}
});
