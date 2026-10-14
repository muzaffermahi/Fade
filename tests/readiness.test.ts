import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, symlinkSync, unlinkSync, existsSync } from 'node:fs';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';

/** Assertions read the current workspace component, never accumulated terminal bytes. */
class TestTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const tick = () => new Promise<void>(done => setTimeout(done, 40));
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]).toString('base64');
async function fixture(failure = false, attachments = false) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-readiness-'))); store.lock();
  if (attachments) store.saveTerminal({ sessionId: 'welcome', mode: 'fade', focus: 'builder', builderDraft: '', companionDraft: '', builderScroll: 0, companionScroll: 0,
    builderAttachments: [{ type: 'image', mimeType: 'image/png', data: png('builder') }], companionAttachments: [{ type: 'image', mimeType: 'image/png', data: png('companion') }] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'synthetic-never-sent');
  let calls = 0;
  const bridge = await createFadeRuntime(store, {}, () => ({
    build: async () => { throw new Error('No implementation authorized'); },
    converse: async () => { calls++; if (failure) throw new Error('Synthetic provider unavailable'); return { reply: 'Ready to explore.', evidence: [], openQuestions: [], next: null }; }, close() {},
  }), { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } }) });
  const terminal = new TestTerminal(); const mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
  return { ...bridge, bridge, terminal, calls: () => calls, close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}

test('G01/G02/G03 F-TUI: slash opens visible completion in each actual split editor', async () => {
  const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    for (const role of ['builder', 'companion'] as const) {
      root.view.focus = role; root.editors[role].setText(''); f.terminal.input('/'); await tick();
      assert.equal(root.editors[role].isShowingAutocomplete(), true, role);
      assert.match(root.render(120).join('\n'), /Search Fade commands|Inspect Builder|Fade help|Open Pi settings/);
    }
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
test('G05 F-CONTROL: unknown slash stays editable in Fade and invokes no provider', async () => {
  const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    root.editors.builder.setText('/does-not-exist original  arguments'); f.terminal.input('\r'); await tick(); await f.app.idle();
    assert.equal(f.calls(), 0, 'unknown commands must not enter the model loop');
    assert.ok(f.bridge.workspaceView === root, 'workspace must remain mounted');
    assert.equal(root.editors.builder.getExpandedText(), '/does-not-exist original  arguments');
    assert.match(root.render(120).join('\n'), /Unknown command/);
  } finally { await f.close(); }
});
test('G07/G08 F-CONTROL: preference completes visibly without leaving the workspace', async () => {
  const f = await fixture();
  try {
    await f.app.submit('Explore the current idea'); const root = f.bridge.workspaceView; assert.ok(root);
    root.editors.builder.setText('/preference technical'); f.terminal.input('\r'); await tick(); 
    assert.equal(f.app.coordinator?.state.preference, 'technical');
    assert.ok(f.bridge.workspaceView === root, 'preference must preserve split surface');
    assert.match(root.render(120).join('\n'), /Conversation preference: technical/);
  } finally { await f.close(); }
});
test('G05/G08/G11 F-CONTROL: both split composers reject bare slash, typo and controls unavailable on this surface locally', async () => {
  const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    for (const role of ['builder', 'companion'] as const) for (const text of ['  /  ', '  /preferece technical', '/write']) {
      root.view.focus = role; root.editors[role].setText(text); f.terminal.input('\r'); await tick();
      assert.equal(f.calls(), 0); assert.ok(f.bridge.workspaceView === root);
      assert.equal(root.editors[role].getExpandedText(), text);
      assert.ok(/Type a command|Unknown command|unavailable/.test(root.render(120).join('\n')));
    }
    await f.runtime.session.prompt('/unknown-native-command'); assert.equal(f.calls(), 0);
    assert.equal(f.app.coordinator, undefined);
  } finally { await f.close(); }
});
test('G06/G08/G11 F-CONTROL: pasted whitespace command preserves arguments and reports handler failure', async () => {
  const f = await fixture();
  try {
    await f.app.submit('Explore'); const root = f.bridge.workspaceView; assert.ok(root);
    f.terminal.input('\x1b[200~  /preference technical\x1b[201~'); f.terminal.input('\r'); await tick();
    assert.equal(f.app.coordinator?.state.preference, 'technical'); assert.equal(f.calls(), 1); assert.ok(f.bridge.workspaceView === root);
    root.editors.builder.setText('/preference invalid'); f.terminal.input('\r'); await tick();
    assert.equal(root.editors.builder.getExpandedText(), '/preference invalid'); assert.equal(f.calls(), 1);
    assert.match(root.render(120).join('\n'), /design or technical/);
    root.editors.builder.setText('/builder Preserve  two spaces'); f.terminal.input('\r'); await tick();
    assert.equal(f.app.coordinator?.state.builderMessages?.[0]?.text, 'Preserve  two spaces'); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
test('G21 F-TUI: provider cause and recovery action appear on the current split screen', async () => {
  const f = await fixture(true);
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    root.view.focus = 'companion'; root.editors.companion.setText('Inspect the project'); f.terminal.input('\r'); await tick(); await f.app.idle();
    assert.equal(f.app.coordinator?.state.inputs[0]?.status, 'failed');
    assert.match(root.render(120).join('\n'), /Synthetic provider unavailable/);
    assert.match(root.render(120).join('\n'), /retry|inputs|recovery/i);
  } finally { await f.close(); }
});
test('G31/G32 F-INPUT: new session excludes old conversation from application history', async () => {
  const f = await fixture();
  try {
    await f.app.submit('Old session private thought'); await f.app.setSession('new-session-fixture');
    assert.equal(f.app.history().some(m => m.text === 'Old session private thought'), false);
    assert.equal(f.app.coordinator?.state.conversation.some(m => m.text === 'Old session private thought'), true, 'provenance must remain saved');
  } finally { await f.close(); }
});

test('G31/G33 F-TUI: actual split captures role, session and images before pane changes; native new isolates drafts and transcript', async () => {
  const f = await fixture(false, true);
  try {
    const root = f.workspaceView; assert.ok(root); const oldId = f.app.currentSessionId;
    root.view.focus = 'builder'; root.editors.builder.setText('Identical split thought'); f.terminal.input('\r'); f.terminal.input('\t');
    assert.equal(root.view.focus, 'companion'); root.editors.companion.setText('Identical split thought'); f.terminal.input('\r'); f.terminal.input('\t');
    await tick(); await f.app.idle(); const c = f.app.coordinator; assert.ok(c);
    assert.deepEqual(c.state.inputs.map(input => ({ role: input.role, sessionId: input.sessionId, images: f.app.store.images(input.attachments).map(image => image.data) })), [
      { role: 'builder', sessionId: oldId, images: [png('builder')] }, { role: 'companion', sessionId: oldId, images: [png('companion')] }]);
    root.editors.companion.setText('Old session unsent draft'); root.view.focus = 'builder'; root.editors.builder.setText('/new'); f.terminal.input('\r');
    for (let index = 0; index < 30 && (!f.bridge.workspaceView || f.bridge.workspaceView === root); index++) await tick();
    const refreshed = f.bridge.workspaceView; assert.ok(refreshed && refreshed !== root); assert.notEqual(f.app.currentSessionId, oldId);
    assert.equal(refreshed.editors.companion.getExpandedText(), ''); assert.equal(refreshed.render(120).join('\n').includes('Identical split thought'), false);
    assert.equal(f.app.store.loadTerminal(oldId)?.companionDraft, 'Old session unsent draft');
    assert.deepEqual(f.app.history(), []); assert.equal(c.state.conversation.filter(record => record.role === 'human').length, 2);
  } finally { await f.close(); }
});
test('G34/G35 F-EVIDENCE: fabricated claims with zero observed checks cannot unlock verified work', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-evidence-gap-')));
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Project'), store, {
    build: async () => ({ status: 'completed', summary: 'Claims implementation', verification: ['All tests pass'], discoveries: [] }),
    converse: async (_state, text) => ({ reply: 'Preparing', evidence: [{ key: 'change', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
      title: 'Change', goal: text, requirements: [text], acceptanceChecks: ['node test.mjs'], decisionKeys: ['change'], dependencies: [], assumptions: [], ready: true,
    } }), close() {},
  });
  try {
    await c.talk('Implement this change'); await c.idle(); assert.equal(c.state.verificationEvidence.length, 0);
    assert.equal(c.state.slices[0]?.status, 'blocked', 'missing required observed checks must hold completion/dependencies');
  } finally { await c.close(); }
});
test('G36 F-CONTINUITY: escaped .fade junction or symlink is rejected before lock writes', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-path-gap-')); const outside = mkdtempSync(join(tmpdir(), 'fade-outside-gap-'));
  const link = join(workspace, '.fade'); symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  let store: Store | undefined;
  try {
    assert.throws(() => { store = new Store(workspace); store.lock(); }, /state|workspace|contain|escape/i);
    assert.equal(existsSync(join(outside, 'lock')), false);
  } finally { store?.close(); unlinkSync(link); }
});

test('G41/G42 F-INPUT/F-TUI: actual split rejects tampered storage and restores the captured role draft and images', async () => {
  const f = await fixture(false, true);
  try {
    await f.app.submit('Previously saved thought'); const root = f.bridge.workspaceView; assert.ok(root);
    root.view.focus = 'builder'; root.editors.builder.setText('Unsaved Builder thought');
    const images = structuredClone(root.view.builderAttachments);
    appendFileSync(join(f.app.store.directory, 'journal.jsonl'), '{"interrupted":');
    f.terminal.input('\r'); f.terminal.input('\t'); await tick(); await f.app.idle();
    assert.equal(root.view.focus, 'companion'); assert.equal(root.editors.builder.getExpandedText(), 'Unsaved Builder thought');
    assert.deepEqual(root.view.builderAttachments, images); assert.equal(f.calls(), 1);
    assert.equal(f.app.coordinator?.state.inputs.length, 1); assert.equal(f.app.coordinator?.state.mode, 'paused');
    assert.match(root.render(120).join('\n'), /Storage failure|outside Store|not accepted/);
    assert.ok(f.bridge.workspaceView === root);
  } finally { await f.close(); }
});
