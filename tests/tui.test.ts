import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthStorage, ModelRegistry, SettingsManager } from '@mariozechner/pi-coding-agent';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import type { Agents } from '../src/coordinator.js';
import type { BuilderResult, CompanionReply } from '../src/contracts.js';

const reply: CompanionReply = { reply: 'A **quiet place** gives unfinished thoughts room.', evidence: [], openQuestions: [], next: null };
const tick = () => new Promise(resolve => setImmediate(resolve));
async function fixture(holdConversation = false, explicitBuilder = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-tui-'))); store.lock();
  const inputs: string[] = [];
  let builds = 0;
  let finish: (() => void) | undefined;
  const agents: Agents = {
    build: async (_slice, signal) => {
      builds++;
      return new Promise<BuilderResult>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
      });
    },
    converse: async (_state, text, signal) => {
      inputs.push(text);
      if (holdConversation && inputs.length === 1) await new Promise<void>(resolve => {
        finish = resolve; signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return reply;
    },
    close: () => {},
  };
  const authStorage = AuthStorage.inMemory();
  const modelRegistry = ModelRegistry.inMemory(authStorage);
  const configured = modelRegistry.getAll().find(model => model.provider === 'anthropic');
  assert.ok(configured);
  authStorage.setRuntimeApiKey(configured.provider, 'fixture-key-never-sent');
  const bridge = await createFadeRuntime(store, explicitBuilder ? { builderModel: `${configured.provider}/${configured.id}` } : {}, () => agents, {
    authStorage, modelRegistry, settingsManager: SettingsManager.inMemory({ packages: [],
      defaultProvider: configured.provider, defaultModel: configured.id }),
  });
  await bridge.runtime.session.bindExtensions({});
  return { ...bridge, store, inputs, configured, builds: () => builds, finish: () => finish?.() };
}

test('FADE-15: ordinary native Pi submissions run Fade automatically, with a separate concurrent Builder and prose renderer', async () => {
  const f = await fixture();
  try {
    await f.runtime.session.prompt('Build a quiet notebook.\nLet unfinished thoughts stay unfinished.');
    await tick();
    assert.equal(f.builds(), 1);
    assert.equal(f.inputs.length, 1);
    assert.equal(f.app.coordinator?.state.slices[0]?.status, 'running');
    assert.equal(f.runtime.session.isStreaming, false);
    assert.deepEqual(f.runtime.session.getActiveToolNames(), []);
    assert.equal(f.runtime.session.model?.provider, f.configured.provider);
    assert.equal(f.runtime.session.model?.id, f.configured.id);
    f.runtime.services.modelRegistry.refresh();
    assert.equal(f.app.options.builderModel, `${f.configured.provider}/${f.configured.id}`);
    const message = f.runtime.session.messages.find(m => m.role === 'custom' && m.customType === 'fade-companion');
    assert.ok(message && message.role === 'custom');
    assert.equal(message.content, reply.reply);
    const renderer = f.runtime.session.extensionRunner?.getMessageRenderer('fade-companion');
    assert.ok(renderer);
    assert.ok(f.runtime.session.extensionRunner?.getCommand('continue'));
    assert.ok(f.runtime.session.extensionRunner?.getCommand('intent'));
    const alternate = f.runtime.services.modelRegistry.getAll().find(model => model.provider !== f.configured.provider);
    assert.ok(alternate);
    await f.runtime.session.extensionRunner?.emit({ type: 'model_select', model: alternate,
      previousModel: f.runtime.session.model, source: 'set' });
    assert.equal(f.app.options.companionModel, `${alternate.provider}/${alternate.id}`);
    assert.equal(f.app.options.builderModel, `${alternate.provider}/${alternate.id}`);
    await f.runtime.session.extensionRunner?.emit({ type: 'thinking_level_select', level: 'low', previousLevel: 'off' });
    assert.equal(f.app.options.companionThinkingLevel, 'low');
    await f.runtime.session.prompt('/pause');
    assert.equal(f.app.coordinator?.state.mode, 'paused');
    assert.equal((await f.runtime.newSession()).cancelled, true);
    const shell = await f.runtime.session.extensionRunner?.emitUserBash({ type: 'user_bash',
      command: 'echo must-not-execute', cwd: f.store.workspace, excludeFromContext: false });
    assert.equal(shell?.result?.exitCode, 1);
    assert.match(shell?.result?.output ?? '', /ordinary prompt/);
  } finally { await f.runtime.dispose(); }
  assert.equal(existsSync(join(f.store.directory, 'lock')), false);
});

test('FADE-16: rapid prompts are durably saved immediately and processed in order without a second Pi model loop', async () => {
  const f = await fixture(true);
  try {
    await f.runtime.session.prompt('First thought');
    await tick();
    await f.runtime.session.prompt('Second thought');
    assert.deepEqual(f.store.load()?.conversation.filter(m => m.role === 'human').map(m => m.text), ['First thought', 'Second thought']);
    assert.deepEqual(f.inputs, ['First thought']);
    f.finish(); await tick(); await tick();
    assert.deepEqual(f.inputs, ['First thought', 'Second thought']);
    assert.equal(f.app.coordinator?.state.conversation.filter(m => m.role === 'human').length, 2);
    assert.equal(f.runtime.session.isStreaming, false);
  } finally { await f.runtime.dispose(); }
});

test('FADE-17: quitting while thinking preserves queued thoughts and recovery is paused in the native display history', async () => {
  const f = await fixture(true);
  await f.runtime.session.prompt('First thought'); await tick();
  await f.runtime.session.prompt('A second thought worth keeping');
  await f.runtime.dispose();
  assert.equal(f.store.load()?.conversation.filter(m => m.role === 'human').length, 2);
  assert.equal(existsSync(join(f.store.directory, 'lock')), false);
  f.store.lock();
  const authStorage = AuthStorage.inMemory();
  const restored = await createFadeRuntime(f.store, {}, () => ({
    build: async () => { throw new Error('Recovery must not start a Builder'); },
    converse: async () => reply, close: () => {},
  }), { authStorage, modelRegistry: ModelRegistry.inMemory(authStorage), settingsManager: SettingsManager.inMemory() });
  try {
    await restored.runtime.session.bindExtensions({});
    assert.equal(restored.app.coordinator?.state.mode, 'paused');
    assert.ok(restored.runtime.session.messages.some(m => m.role === 'custom' && m.content === 'A second thought worth keeping'));
    await restored.runtime.session.prompt('/unknown');
    assert.equal(restored.runtime.session.isStreaming, false);
  } finally { await restored.runtime.dispose(); }
});

test('FADE-18: Pi selection changes future Fade turns while an explicitly configured Builder remains independent', async () => {
  const f = await fixture(false, true);
  try {
    const alternate = f.runtime.services.modelRegistry.getAll().find(model => model.provider !== f.configured.provider);
    assert.ok(alternate);
    await f.runtime.session.extensionRunner?.emit({ type: 'model_select', model: alternate,
      previousModel: f.runtime.session.model, source: 'set' });
    assert.equal(f.app.options.companionModel, `${alternate.provider}/${alternate.id}`);
    assert.equal(f.app.options.builderModel, `${f.configured.provider}/${f.configured.id}`);
  } finally { await f.runtime.dispose(); }
});
