import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { CombinedAutocompleteProvider, visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import { fadeAutocomplete, commandCatalog } from '../src/commands.js';

class ComposerTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const tick = () => new Promise<void>(done => setTimeout(done, 50));
const currentWorkspace = (bridge: Awaited<ReturnType<typeof createFadeRuntime>>) => bridge.workspaceView;

test('G14/G16/G38 F21: actual split tray removal, marker deletion, oversized send and role-boundary draft flush invoke no provider', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-image-tray-')), seeded = new Store(workspace);
  const first = '[image:11111111-1111-1111-1111-111111111111]', second = '[image:22222222-2222-2222-2222-222222222222]';
  const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') };
  seeded.saveTerminal({ sessionId: 'welcome', mode: 'fade', focus: 'builder', builderDraft: `${first} ${second} Retain text`, companionDraft: 'Other role draft',
    builderAttachments: [{ ...image, draftMarker: first }, { ...image, draftMarker: second }], companionAttachments: [image], builderScroll: 0, companionScroll: 0 });
  const f = await fixture(workspace);
  try {
    const root = f.bridge.workspaceView; assert.ok(root); assert.match(root.render(120).join('\n'), /Images 2\/20|Ctrl\+Alt\+I/);
    root.openAttachments(); f.terminal.input('\r'); await tick();
    assert.equal(root.view.builderAttachments?.length, 1); assert.equal(root.view.companionAttachments?.length, 1);
    assert.equal(root.editors.builder.getExpandedText().includes(first), false); assert.equal(root.editors.builder.getExpandedText().includes(second), true);
    root.editors.builder.setText('Retain text after deleting the marker'); assert.equal(root.view.builderAttachments?.length, 0);
    f.terminal.input('\t'); await tick(); const saved = new Store(workspace).loadTerminal(root.view.sessionId);
    assert.equal(saved?.builderDraft, 'Retain text after deleting the marker'); assert.equal(saved?.builderAttachments?.length, 0);
    assert.equal(root.view.focus, 'companion'); assert.equal(root.editors.companion.getExpandedText(), 'Other role draft');
    root.openAttachments(); f.terminal.input('\x1b[B'); f.terminal.input('\r'); await tick();
    assert.equal(root.view.companionAttachments?.length, 0); assert.equal(root.editors.companion.getExpandedText(), 'Other role draft');
    const oversized = 'x'.repeat(20001); root.editors.companion.setText(oversized); f.terminal.input('\r'); await tick();
    assert.equal(root.editors.companion.getExpandedText(), oversized); assert.equal(f.calls(), 0); assert.equal(f.bridge.app.coordinator, undefined);
    assert.match(root.render(120).join('\n'), /Over limit|20,000.*draft/);
  } finally { await f.close(); }
});

test('G15/G42 F21: a selected text-only model rejects a split image submission with its original draft and tray intact', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-vision-capability-')), seeded = new Store(workspace);
  const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64') };
  seeded.saveTerminal({ sessionId: 'welcome', mode: 'fade', focus: 'companion', builderDraft: '', companionDraft: 'Describe this image',
    builderAttachments: [], companionAttachments: [image], builderScroll: 0, companionScroll: 0 });
  const f = await fixture(workspace);
  try {
    const root = f.bridge.workspaceView; assert.ok(root); const model = f.bridge.runtime.session.model; assert.ok(model);
    await f.bridge.runtime.session.setModel({ ...model, input: ['text'] }); root.view.focus = 'companion';
    f.terminal.input('\r'); await tick();
    assert.equal(root.editors.companion.getExpandedText(), 'Describe this image'); assert.equal(root.view.companionAttachments?.length, 1);
    assert.equal(f.calls(), 0); assert.equal(f.bridge.app.coordinator, undefined); assert.match(root.render(120).join('\n'), /does not support images/);
  } finally { await f.close(); }
});
async function fixture(workspace = mkdtempSync(join(tmpdir(), 'fade-composer-'))) {
  const store = new Store(workspace); store.lock();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'synthetic-never-sent');
  let calls = 0;
  const bridge = await createFadeRuntime(store, {}, () => ({
    build: async (_slice, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })),
    converse: async (_state, text) => {
      calls++;
      return text.startsWith('Build') ? { reply: 'Preparing', evidence: [{ key: 'change', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
        title: 'Change', goal: text, requirements: ['Local module'], acceptanceChecks: ['node test.mjs'], decisionKeys: ['change'], dependencies: [], assumptions: [], ready: true,
      } } : { reply: 'Explore', evidence: [], openQuestions: [], next: null };
    }, close() {},
  }), { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } }) });
  const terminal = new ComposerTerminal(); const mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
  return { bridge, terminal, store, calls: () => calls, close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}
test('G01–G04 F-TUI: real role pickers have visible paging, Tab ownership, Escape dismissal and measured rows at all sizes', async () => {
  const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root); const captures = join(f.store.workspace, 'captures'); mkdirSync(captures);
    for (const [width, height] of [[120, 40], [80, 24], [45, 20]]) for (const role of ['builder', 'companion'] as const) {
      f.terminal.columns = width ?? 120; f.terminal.rows = height ?? 40; root.view.focus = role;
      root.editors[role].setText(''); f.terminal.input('/'); await tick();
      assert.equal(root.editors[role].isShowingAutocomplete(), true);
      const first = root.render(f.terminal.columns); assert.ok(first.length <= f.terminal.rows);
      assert.match(first.join('\n'), /→/); assert.match(first.join('\n'), /\d+\/\d+/);
      if (f.terminal.rows <= 24) assert.match(first.join('\n'), /Tab accepts.*Escape closes/);
      assert.match(first.join('\n'), new RegExp(`Message ${role === 'builder' ? 'Builder' : 'Companion'}`));
      for (const row of first) assert.ok(visibleWidth(row) <= f.terminal.columns);
      for (let index = 0; index < 9; index++) f.terminal.input('\x1b[B');
      assert.notEqual(root.render(f.terminal.columns).join('\n'), first.join('\n'), 'picker must page to the selected command');
      writeFileSync(join(captures, `${width}x${height}-${role}.txt`), root.render(f.terminal.columns).join('\n'));
      f.terminal.input('\x1b'); assert.equal(root.editors[role].isShowingAutocomplete(), false); await tick();
      assert.equal(root.editors[role].isShowingAutocomplete(), false, 'dismissal stays closed without new input');
      root.editors[role].setText(''); f.terminal.input('/pref'); await tick(); f.terminal.input('\t');
      assert.equal(root.view.focus, role); assert.match(root.editors[role].getText(), /^\/preference /);
      f.terminal.input('technical'); await tick(); f.terminal.input('\r'); await tick();
      // No project yet: the operation still routes locally and has a visible result.
      assert.equal(f.calls(), 0); assert.ok(f.bridge.workspaceView === root);
      f.terminal.input('\t'); assert.notEqual(root.view.focus, role, 'Tab switches after picker is closed');
    }
    console.log(`F15 current-screen captures: ${captures}`);
  } finally { await f.close(); }
});
test('G04/G11/G17 F-TUI: exact arguments execute, completion preserves suffix arguments and history recall stays native', async () => {
  const f = await fixture();
  try {
    await f.bridge.app.submit('Explore'); const root = f.bridge.workspaceView; assert.ok(root);
    f.terminal.input('/preference technical'); await tick(); f.terminal.input('\r'); await tick();
    assert.equal(f.bridge.app.coordinator?.state.preference, 'technical'); assert.equal(f.calls(), 1);
    f.terminal.input('\x1b[A'); assert.equal(root.editors.builder.getText(), '/preference technical');
    root.editors.builder.setText(''); f.terminal.input('/help'); await tick(); f.terminal.input('\r'); await tick();
    assert.ok(f.bridge.workspaceView === root, 'Enter selected command opens inspection while keeping split root');
    f.terminal.input('\x1b'); await tick(); assert.equal(f.calls(), 1);
    const native = new CombinedAutocompleteProvider([{ name: 'builder' }], f.store.workspace);
    const adapter = fadeAutocomplete(native, () => commandCatalog());
    const completed = adapter.applyCompletion(['/bui  preserve  arguments'], 0, 4, { value: 'builder', label: 'builder' }, '/bui');
    assert.ok(completed.lines[0]?.includes('preserve  arguments'));
    const disabledAdapter = fadeAutocomplete(native, () => commandCatalog().map(command => command.name === 'doctor' ? { ...command, available: false, disabledReason: 'Synthetic unavailable control' } : command));
    const disabled = disabledAdapter.applyCompletion(['/doctor'], 0, 7, { value: 'doctor', label: 'doctor' }, '/doctor');
    assert.deepEqual(disabled.lines, ['/doctor']);
  } finally { await f.close(); }
});
test('G02/G09/G17 F-TUI: public provider refresh discovers resources and native model shortcut preserves drafts', async () => {
  const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    mkdirSync(join(f.store.workspace, '.pi', 'prompts'), { recursive: true }); writeFileSync(join(f.store.workspace, '.pi', 'prompts', 'visible-template.md'), 'Explore $1');
    await f.bridge.runtime.session.resourceLoader.reload();
    root.editors.builder.setText(''); f.terminal.input('/visible'); await tick();
    assert.match(root.render(120).join('\n'), /visible-template/);
    f.terminal.input('\x1b'); root.editors.builder.setText('Saved Builder draft'); root.editors.companion.setText('Saved Companion draft');
    f.terminal.input('\x0c'); await tick(); assert.equal(f.bridge.workspaceView, undefined, 'Ctrl+L must reach native model controls');
    const saved = f.store.loadTerminal(f.bridge.app.currentSessionId); assert.equal(saved?.builderDraft, 'Saved Builder draft'); assert.equal(saved?.companionDraft, 'Saved Companion draft');
    f.terminal.input('\x1b'); await tick(); await f.bridge.runtime.session.prompt('/fade'); await tick();
    const reopened = currentWorkspace(f.bridge); assert.ok(reopened);
    assert.equal(reopened.editors.builder.getText(), 'Saved Builder draft'); assert.equal(reopened.editors.companion.getText(), 'Saved Companion draft');
  } finally { await f.close(); }
});
test('G04/G10 F-CONTROL: remapped pane control remains separate from Tab completion', async () => {
  const old = process.env.FADE_PANE_KEY; process.env.FADE_PANE_KEY = 'ctrl+space'; const f = await fixture();
  try {
    const root = f.bridge.workspaceView; assert.ok(root);
    f.terminal.input('/pref'); await tick(); f.terminal.input('\t'); assert.equal(root.view.focus, 'builder');
    assert.match(root.editors.builder.getText(), /^\/preference/); f.terminal.input('\x00'); assert.equal(root.view.focus, 'companion');
  } finally { await f.close(); if (old === undefined) delete process.env.FADE_PANE_KEY; else process.env.FADE_PANE_KEY = old; }
});
test('G10 F-CONTROL: focused Ctrl+C interrupts then exits; empty Ctrl+D exits and nonempty Ctrl+D deletes forward', async () => {
  const probe = process.env.FADE_EXIT_PROBE;
  if (probe) {
    const workspace = process.env.FADE_EXIT_WORKSPACE; assert.ok(workspace); const f = await fixture(workspace);
    try {
      const root = f.bridge.workspaceView; assert.ok(root);
      if (probe === 'ctrl-c') {
        await f.bridge.app.submit('Build a local module', { role: 'builder' }); root.view.focus = 'builder';
        f.terminal.input('/'); await tick(); f.terminal.input('\x1b'); assert.equal(f.bridge.app.coordinator?.state.slices[0]?.status, 'running');
        root.editors.builder.setText('draft before exit'); f.terminal.input('\x03'); await tick();
        assert.equal(f.bridge.app.coordinator?.state.mode, 'paused'); assert.ok(f.bridge.workspaceView === root);
        const state = f.bridge.app.coordinator?.state; assert.ok(state);
        assert.equal(f.store.loadTerminal(state.currentSessionId)?.builderDraft, 'draft before exit');
      } else {
        f.terminal.input('abc'); f.terminal.input('\x01'); f.terminal.input('\x04'); assert.equal(root.editors.builder.getText(), 'bc');
        assert.ok(f.bridge.workspaceView === root); root.editors.builder.setText('');
      }
      writeFileSync(join(workspace, 'exit-probe.json'), JSON.stringify({ probe, assertionsBeforeExit: true }));
      f.terminal.input(probe === 'ctrl-c' ? '\x03' : '\x04'); await tick(); await tick();
      assert.fail('The native orderly shutdown must exit this child process.');
    } finally { await f.close(); }
    return;
  }
  for (const scenario of ['ctrl-c', 'ctrl-d']) {
    const workspace = mkdtempSync(join(tmpdir(), 'fade-exit-'));
    const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, FADE_EXIT_PROBE: scenario, FADE_EXIT_WORKSPACE: workspace };
      delete environment.NODE_TEST_CONTEXT;
      const child = spawn(process.execPath, ['--import', 'tsx', '--test', '--test-name-pattern', '^G10 F-CONTROL:', fileURLToPath(import.meta.url)],
        { cwd: fileURLToPath(new URL('..', import.meta.url)), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; const timeout = setTimeout(() => { child.kill(); reject(new Error('Native exit probe timed out: ' + output)); }, 10000);
      child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
      child.once('error', error => { clearTimeout(timeout); reject(error); }); child.once('exit', code => { clearTimeout(timeout); resolve({ code, output }); });
    });
    assert.equal(result.code, 0, result.output); assert.match(readFileSync(join(workspace, 'exit-probe.json'), 'utf8'), /assertionsBeforeExit/);
    assert.equal(existsSync(join(workspace, '.fade', 'lock')), false, 'native shutdown must release the coordinator lock');
  }
});
