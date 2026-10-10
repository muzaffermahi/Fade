import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage, type ToolCall } from '@earendil-works/pi-ai';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import type { Agents } from '../src/coordinator.js';
import type { BuilderResult, CompanionReply } from '../src/contracts.js';

const reply: CompanionReply = { reply: 'A **quiet place** gives unfinished thoughts room.', evidence: [], openQuestions: [], next: null };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function config() {
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-key-never-sent');
  return { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [],
    defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } }), model };
}
async function fixture(holdConversation = false, explicitBuilder = false, native = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-tui-'))); store.lock();
  const inputs: string[] = []; let builds = 0; let finish: (() => void) | undefined;
  const configured = await config();
  const bridge = await createFadeRuntime(store, explicitBuilder ? { builderModel: `${configured.model.provider}/${configured.model.id}` } : {},
    (_store, _state, _options, converse): Agents => ({
      build: async (_slice, signal) => { builds++; return new Promise<BuilderResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      }); },
      converse: async (state, text, signal) => {
        inputs.push(text);
        if (native) { assert.ok(converse); return converse(state, text, signal); }
        if (holdConversation && inputs.length === 1) await new Promise<void>(resolve => {
          finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return reply;
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

test('FADE-15: ordinary prompts automatically run Fade concurrently while preserving stock tools, shell input, and session navigation', async () => {
  const f = await fixture();
  try {
    await f.runtime.session.prompt('Build a quiet notebook.'); await settle(f);
    assert.equal(f.builds(), 1); assert.deepEqual(f.inputs, ['Build a quiet notebook.']);
    assert.equal(f.app.coordinator?.state.slices[0]?.status, 'running');
    for (const tool of ['read', 'bash', 'edit', 'write', 'fade_update_intent']) assert.ok(f.runtime.session.getActiveToolNames().includes(tool), tool);
    assert.equal(f.runtime.session.model?.id, f.configured.model.id);
    assert.equal(f.app.options.builderModel, `${f.configured.model.provider}/${f.configured.model.id}`);
    assert.ok(f.runtime.session.extensionRunner?.getCommand('mcp'));
    const shell = await f.runtime.session.extensionRunner?.emitUserBash({ type: 'user_bash', command: 'echo native-shell', cwd: f.store.workspace, excludeFromContext: false });
    assert.equal(shell, undefined);
    const executed = await f.runtime.session.executeBash('echo native-shell'); assert.match(executed.output, /native-shell/);
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
    assert.ok(restored.app.history().some(m => m.text === 'A second thought worth keeping'));
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

test('FADE-19: native Companion reads real files, streams tool events, writes and edits with stock Pi tools, and records validated intent', async () => {
  const f = await fixture(false, false, true);
  const human = 'Read essay.md and improve the draft.';
  writeFileSync(join(f.store.workspace, 'essay.md'), 'The lantern remembers the rain.');
  let calls = 0; const tools: string[] = [];
  const off = f.runtime.session.subscribe(event => { if (event.type === 'tool_execution_start') tools.push(event.toolName); });
  f.runtime.session.agent.streamFunction = (model, context) => {
    calls++;
    if (calls === 1) {
      assert.ok(context.messages.some(m => m.role === 'system' && m.toolsAdded?.some(t => t.name === 'read')));
      return response(model, [{ type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'essay.md' } }], true);
    }
    if (calls === 2) {
      assert.ok(context.messages.some(m => m.role === 'toolResult' && JSON.stringify(m.content).includes('lantern remembers')));
      const requests: ToolCall[] = [
        { type: 'toolCall', id: 'write-1', name: 'write', arguments: { path: 'draft.md', content: 'The lantern holds the rain.' } },
        { type: 'toolCall', id: 'intent-1', name: 'fade_update_intent', arguments: { evidence: [{ key: 'writing', text: 'Improve the existing draft', quote: human, kind: 'decision' }], openQuestions: [], next: null } },
      ]; return response(model, requests, true);
    }
    if (calls === 3) return response(model, [{ type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'draft.md', oldText: 'holds', newText: 'carries' } }], true);
    return response(model, [{ type: 'text', text: 'I read the lantern sentence and revised the draft.' }]);
  };
  try {
    await f.runtime.session.prompt(human); await settle(f);
    assert.equal(calls, 4); assert.deepEqual(tools, ['read', 'write', 'fade_update_intent', 'edit']);
    assert.equal(readFileSync(join(f.store.workspace, 'draft.md'), 'utf8'), 'The lantern carries the rain.');
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
    for (let i = 0; i < 200 && !f.runtime.session.messages.some(m => m.role === 'custom' && m.customType === 'fade-note' && String(m.content).includes('verbatim')); i++) await new Promise(done => setTimeout(done, 10));
    assert.equal(f.app.coordinator?.state.intent.decisions.length, 0);
    assert.equal(f.app.history()[0]?.text, 'Can we inspect first?');
    assert.ok(f.runtime.session.messages.some(m => m.role === 'custom' && String(m.content).includes('verbatim')));
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
    const report = f.runtime.session.messages.findLast(m => m.role === 'custom' && String(m.content).includes('Your Builder notes'));
    assert.ok(report);
    const slice = f.app.coordinator?.state.slices[0]; assert.ok(slice);
    assert.match(sliceReport({ ...slice, status: 'completed', result: { status: 'completed', summary: 'Edited the draft', verification: ['node test.mjs: passed'], discoveries: [] } }), /Checks reported:[\s\S]*node test.mjs: passed/);
    const log = executionLog(JSON.stringify({ event: { event: { type: 'tool_execution_end', toolName: 'bash', isError: true, result: { content: [{ type: 'text', text: 'test failed: empty input' }] } } } }));
    assert.match(log, /bash · failed/); assert.match(log, /empty input/); assert.doesNotMatch(log, /tool_execution_end/);
    await f.runtime.session.prompt('/reports');
    assert.ok(f.runtime.session.messages.some(m => m.role === 'custom' && String(m.content).includes('Companion · latest reply')));
  } finally { await f.app.close(); await f.runtime.dispose(); }
});
