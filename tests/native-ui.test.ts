import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { Text, TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import { NativeUIAdapter } from '../src/native-ui.js';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';

class NativeTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const tick = () => new Promise<void>(done => setTimeout(done, 50));
const currentWorkspace = (bridge: Awaited<ReturnType<typeof createFadeRuntime>>) => bridge.workspaceView;
async function fixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-native-adapter-'))); store.lock();
  store.saveTerminal({ sessionId: 'welcome', mode: 'fade', focus: 'builder', builderDraft: 'Builder draft', companionDraft: 'Companion draft', builderScroll: 0, companionScroll: 0,
    builderAttachments: [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }], companionAttachments: [] });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'synthetic-never-sent');
  let calls = 0;
  const bridge = await createFadeRuntime(store, {}, () => ({
    build: async (_slice, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })),
    converse: async (_state, text) => { calls++; return text.startsWith('Build') ? { reply: 'Preparing', evidence: [{ key: 'change', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
      title: 'Change', goal: text, requirements: ['Local module'], acceptanceChecks: ['node test.mjs'], decisionKeys: ['change'], dependencies: [], assumptions: [], ready: true,
    } } : { reply: 'Explore', evidence: [], openQuestions: [], next: null }; }, close() {},
  }), { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } }) });
  const terminal = new NativeTerminal(); const mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
  return { bridge, terminal, store, model, calls: () => calls, close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}
async function waitForWorkspace(bridge: Awaited<ReturnType<typeof createFadeRuntime>>) {
  for (let index = 0; index < 30 && !currentWorkspace(bridge); index++) await tick();
  const root = currentWorkspace(bridge); assert.ok(root, 'finite native operation must restore Fade'); return root;
}
test('G13 F-TUI: adapter owns roots/cleanup once and restores drafts after native readiness failure', async () => {
  const terminal = new NativeTerminal(); const tui = new TuiMainScreen(terminal); const native = new Text('native', 0, 0); const fade = new Text('fade', 0, 0);
  tui.addChild(native); tui.setFocus(native); const adapter = new NativeUIAdapter(tui); let cleanup = 0; const notices: string[] = [];
  adapter.onUnmount(() => cleanup++); adapter.mount(fade);
  await adapter.handoff({ command: '/model', finite: true }, { unmount: () => adapter.restore(), reopen: () => adapter.mount(fade), notify: message => notices.push(message) });
  assert.equal(cleanup, 1); assert.deepEqual(tui.children, [fade]); assert.match(notices[0] ?? '', /not ready.*Drafts are retained/);
  adapter.dispose(); adapter.dispose(); assert.deepEqual(tui.children, [native]); assert.equal(cleanup, 1);
});
test('G13/G27 F-TUI: native dialogs cancel and return with role drafts, attachment refs, focus and current screen intact', async () => {
  const f = await fixture(); const captures = join(f.store.workspace, 'captures'); mkdirSync(captures);
  try {
    await f.bridge.app.submit('Explore');
    for (const command of ['/model', '/settings', '/thinking', '/login', '/logout', '/tree', '/fork', '/resume']) {
      const root = currentWorkspace(f.bridge); assert.ok(root); root.view.focus = 'builder';
      root.editors.companion.setText('Companion unsent draft'); root.editors.builder.setText(command); f.terminal.input('\r'); await tick();
      if (!currentWorkspace(f.bridge)) {
        const screen = f.bridge.nativeControl?.nativeScreen() ?? []; assert.ok(screen.length, command + ' must expose a native current screen');
        writeFileSync(join(captures, command.slice(1) + '.txt'), screen.join('\n'));
        f.terminal.input('\x1b'); await tick();
      }
      const returned = await waitForWorkspace(f.bridge);
      assert.equal(returned.view.focus, 'builder', command); assert.equal(returned.editors.companion.getExpandedText(), 'Companion unsent draft');
      const state = f.bridge.app.coordinator?.state; assert.ok(state);
      assert.deepEqual(f.store.images(f.store.loadTerminal(state.currentSessionId)?.builderAttachments ?? []), [{ type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' }]);
      assert.equal(f.calls(), 1, 'native dialog must not invoke a provider');
    }
    console.log(`F16 native focus captures: ${captures}`);
  } finally { await f.close(); }
});
test('G13/G17/G31 F-TUI: new/session reload returns to refreshed split without cancelling Builder; pi stays native', async () => {
  const f = await fixture();
  try {
    await f.bridge.app.submit('Build a local module', { role: 'builder' }); const beforeSession = f.bridge.runtime.session.sessionManager.getSessionId();
    const root = currentWorkspace(f.bridge); assert.ok(root); root.view.focus = 'builder'; root.editors.builder.setText('/new'); f.terminal.input('\r');
    await waitForWorkspace(f.bridge); assert.notEqual(f.bridge.runtime.session.sessionManager.getSessionId(), beforeSession);
    assert.equal(f.bridge.app.coordinator?.state.slices[0]?.status, 'running');
    const refreshed = currentWorkspace(f.bridge); assert.ok(refreshed);
    refreshed.editors.builder.setText('/reload'); f.terminal.input('\r'); await tick(); await waitForWorkspace(f.bridge);
    const afterReload = currentWorkspace(f.bridge); assert.ok(afterReload); afterReload.editors.builder.setText(''); f.terminal.input('/'); await tick();
    assert.equal(afterReload.editors.builder.isShowingAutocomplete(), true); f.terminal.input('\x1b');
    afterReload.editors.builder.setText('/pi'); f.terminal.input('\r'); await tick(); await tick(); assert.equal(currentWorkspace(f.bridge), undefined);
    await f.bridge.runtime.session.prompt('/fade'); const back = await waitForWorkspace(f.bridge); assert.equal(back.editors.builder.getExpandedText(), '');
    assert.equal(f.bridge.app.coordinator?.state.slices[0]?.status, 'running'); assert.equal(f.calls(), 1);
  } finally { await f.close(); }
});
