import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { workStrip } from '../src/projection.js';
import { sharedContext } from '../src/shared-context.js';

/** Exercise the real InteractiveMode renderer without network or the user's terminal settings. */
class CaptureTerminal implements Terminal {
  columns = 80; rows = 24; kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy(lines: number) { this.write(`\x1b[${Math.abs(lines)}${lines < 0 ? 'A' : 'B'}`); }
  hideCursor() { this.write('\x1b[?25l'); } showCursor() { this.write('\x1b[?25h'); }
  clearLine() { this.write('\x1b[2K'); } clearFromCursor() { this.write('\x1b[J'); }
  clearScreen() { this.write('\x1b[2J'); } setTitle(title: string) { this.write(`\x1b]0;${title}\x07`); }
  setProgress() {}
}
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 35));
const currentWorkspace = (bridge: Awaited<ReturnType<typeof createFadeRuntime>>) => bridge.workspaceView;
test('F-TUI: real InteractiveMode renders Fade, work strip, Unicode paste and resize at 80x24 and 120x40', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-render-'))); store.lock();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-never-sent');
  const settingsManager = SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } });
  const bridge = await createFadeRuntime(store, {}, () => ({ build: async () => { throw new Error('Exploration never builds'); },
    converse: async () => ({ reply: 'We can explore the next idea.', evidence: [], openQuestions: [], next: null }), close() {} }), { modelRuntime, settingsManager });
  const terminal = new CaptureTerminal(); const mode = new InteractiveMode(bridge.runtime, { terminal });
  try {
    process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
    await mode.init(); void mode.run(); await tick();
    assert.match(terminal.output, /Fade/); assert.match(terminal.output, /Now:/); assert.match(terminal.output, /Next:/);
    assert.doesNotMatch(terminal.output, /Pi v1\./); assert.match(terminal.output, /Authentication configured/);
    const text = ('What if we changed this? 中文 🌱 ' + 'unfinished thoughts '.repeat(100)).trim();
    terminal.input(`\x1b[200~${text}\x1b[201~`); terminal.input('\r');
    await tick(); await bridge.app.idle(); await tick();
    assert.equal(bridge.app.coordinator?.state.inputs[0]?.text, text);
    assert.equal(bridge.app.coordinator?.state.slices.length, 0);
    const evidence = join(store.workspace, 'captures'); mkdirSync(evidence);
    writeFileSync(join(evidence, '80x24.ansi'), terminal.output);
    terminal.columns = 120; terminal.rows = 40; terminal.resize(); await tick();
    writeFileSync(join(evidence, '120x40.ansi'), terminal.output);
    terminal.columns = 35; terminal.rows = 18; terminal.resize(); await tick();
    assert.match(terminal.output, /Now:/);
    console.log(`Rendered InteractiveMode captures: ${evidence}`);
  } finally { mode.stop(); bridge.disposeView(); await bridge.app.close(); await bridge.runtime.dispose(); }
});
test('F-TUI: work strip remains within four rows and display width with Unicode and unknown costs', () => {
  const state = Coordinator.initial('workspace', 'Explore');
  state.intent.decisions.push({ id: 'conflict', key: '中文'.repeat(30), text: 'Conflict', quote: 'Conflict', kind: 'decision', sourceId: 'source', status: 'conflict' });
  for (const width of [20, 35, 80, 120]) {
    const rows = workStrip(state, width, 0); assert.equal(rows.length, 4);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, row);
  }
  assert.match(workStrip(state, 120).join('\n'), /Cost: unknown/);
});

test('F09: actual Pi split workspace routes independent drafts, restores native UI, preserves focus and handles resize', async () => {
  const noColor = process.env.NO_COLOR; delete process.env.NO_COLOR;
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-split-'))); store.lock();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(m => m.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-never-sent');
  const settingsManager = SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } });
  const bridge = await createFadeRuntime(store, {}, () => ({
    build: async (_slice, signal, emit) => {
      emit({ type: 'tool_execution_start', toolName: 'read', toolCallId: 'read-project', args: { path: 'project.md' } });
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Builder stopped')), { once: true }));
    },
    converse: async (_state, text) => text.startsWith('Build') ? { reply: 'I will build the core first, then check it.', evidence: [{ key: 'core', text, quote: text, kind: 'decision' }], openQuestions: [],
      next: { title: 'Core notes app', goal: text, requirements: ['A local notes module'], acceptanceChecks: ['node --check notes.mjs'], decisionKeys: ['core'], dependencies: [], assumptions: [], ready: true } }
      : { reply: 'Warm paper, roomy margins, and quiet controls. We can explore the reading view while the core is being built.', evidence: [], openQuestions: [], next: null }, close() {},
  }), { modelRuntime, settingsManager });
  const terminal = new CaptureTerminal(); terminal.columns = 120; terminal.rows = 40;
  const mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  try {
    await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
    assert.ok(bridge.workspaceView); assert.match(terminal.output, /A tool for the mind/);
    const captures = join(store.workspace, 'captures'); mkdirSync(captures);
    writeFileSync(join(captures, 'welcome-120x40.txt'), bridge.workspaceView.render(120).join('\n'));
    terminal.input('\x1b[200~Build a local notes app with an editor and simple search.\x1b[201~'); terminal.input('\r');
    await tick(); await tick();
    assert.equal(bridge.app.coordinator?.state.inputs[0]?.role, 'builder');
    assert.equal(bridge.app.coordinator?.state.slices[0]?.status, 'running');
    assert.equal(bridge.workspaceView.view.focus, 'companion');
    terminal.input('Could it feel like a notebook?'); terminal.input('\r'); await tick(); await tick();
    assert.equal(bridge.app.coordinator?.state.inputs.at(-1)?.role, 'companion');
    assert.equal(bridge.app.coordinator?.state.slices.length, 1);
    terminal.input('\x1b[200~中文 🌱 unfinished thought\x1b[201~');
    terminal.input('\t'); terminal.input('Builder draft');
    assert.equal(bridge.workspaceView.editors.companion.getExpandedText(), '中文 🌱 unfinished thought');
    assert.equal(bridge.workspaceView.editors.builder.getExpandedText(), 'Builder draft');
    let root = bridge.workspaceView;
    writeFileSync(join(captures, 'work-120x40.txt'), root.render(120).join('\n'));
    const state = bridge.app.coordinator?.state; assert.ok(state);
    for (let i = 0; i < 15; i++) state.conversation.push({ id: `fixture-${i}`, role: 'companion', targetRole: 'companion', text: `Earlier planning line ${i}`, timestamp: i, scope: 'session', sessionId: state.currentSessionId });
    store.save(state); root.render(120); root.view.companionScroll = 9;
    const before = root.render(120).join('\n');
    state.conversation.push({ id: 'streamed-new', role: 'companion', targetRole: 'companion', text: 'New streamed thought must not replace the draft or steal reading position.', timestamp: 100, scope: 'session', sessionId: state.currentSessionId });
    store.save(state); const after = root.render(120).join('\n');
    assert.equal(root.view.focus, 'builder'); assert.equal(root.editors.companion.getExpandedText(), '中文 🌱 unfinished thought');
    const beforeLines = before.match(/Earlier planning line \d+/g), afterLines = after.match(/Earlier planning line \d+/g);
    assert.deepEqual(afterLines, beforeLines, 'background updates must preserve scrolled content');
    writeFileSync(join(captures, 'scrolled-120x40.txt'), root.render(120).join('\n'));
    writeFileSync(join(captures, 'session.ansi'), terminal.output);
    for (const [columns, rows] of [[80, 24], [120, 40], [45, 20]]) {
      terminal.columns = columns ?? 80; terminal.rows = rows ?? 24; terminal.resize(); await tick();
      const lines = root.render(terminal.columns); assert.ok(lines.length <= terminal.rows);
      for (const line of lines) assert.ok(visibleWidth(line) <= terminal.columns, `${visibleWidth(line)}: ${line}`);
      assert.match(lines.join('\n'), /Now/);
      writeFileSync(join(captures, `${terminal.columns}x${terminal.rows}.txt`), lines.join('\n'));
    }
    root.editors.builder.setText('/help'); terminal.input('\r'); await tick();
    assert.ok(bridge.workspaceView, 'inspection must not replace the workspace'); terminal.input('\x1b'); await tick();
    assert.equal(bridge.app.coordinator?.state.slices[0]?.status, 'running', 'overlay Escape must not pause Builder');
    root.editors.builder.setText('/intent'); terminal.input('\r'); await tick(); terminal.input('\x05'); await tick();
    assert.equal(bridge.workspaceView, undefined, 'native intent editing must become visible');
    terminal.input('\x1b'); await tick();
    const restored = currentWorkspace(bridge); assert.ok(restored); root = restored;
    assert.equal(root.editors.companion.getExpandedText(), '中文 🌱 unfinished thought');
    root.editors.builder.setText('/pi'); terminal.input('\r'); await tick(); assert.equal(bridge.workspaceView, undefined);
    terminal.input('/fade'); terminal.input('\r'); await tick();
    const reopened = currentWorkspace(bridge); assert.ok(reopened); assert.equal(reopened.editors.companion.getExpandedText(), '中文 🌱 unfinished thought');
    terminal.input('\t'); terminal.input('\x1b'); await tick();
    assert.equal(bridge.app.coordinator?.state.slices[0]?.status, 'running', 'Companion Escape leaves Builder running');
    terminal.input('\t'); terminal.input('\x1b'); await tick();
    assert.equal(bridge.app.coordinator?.state.mode, 'paused');
    const context = sharedContext(bridge.app.coordinator.state, 'builder');
    assert.ok(context.humanMessages.some(m => m.role === 'companion' && m.source === 'human message'));
    assert.ok(context.humanMessages.some(m => m.role === 'builder')); assert.ok(context.authority.includes('Context only'));
    console.log(`F09 real renderer captures: ${captures}`);
  } finally { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); if (noColor !== undefined) process.env.NO_COLOR = noColor; }
});
