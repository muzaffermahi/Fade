import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CURSOR_MARKER, visibleWidth, isFocusable } from '@earendil-works/pi-tui';
import { terminalText, renderedText, displayComponent, displayJson, displayValue, underlyingComponent } from '../src/terminal-text.js';
import { visibleText } from '../src/activity.js';
import { observedOutput, toolActivity, operationCard, outcomeCard, builderReport } from '../src/reports.js';
import { InspectionView } from '../src/inspection.js';
import { renderChanges, type WorkspaceSnapshot } from '../src/changes.js';
import { Coordinator } from '../src/coordinator.js';
import { workStrip } from '../src/projection.js';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import { Type } from 'typebox';
import { validate } from '../src/contracts.js';

class LayoutTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false;
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
async function layoutFixture(theme = 'dark', project = false, custom = false, workspace?: string) {
  process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  const store = new Store(workspace ?? mkdtempSync(join(tmpdir(), 'fade-layout-'))); store.lock();
  if (custom) {
    const source: unknown = JSON.parse(readFileSync('node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/dark.json', 'utf8'));
    const config = validate(Type.Object({ name: Type.String(), colors: Type.Record(Type.String(), Type.Union([Type.String(), Type.Integer()])) }, { additionalProperties: true }), source);
    const directory = join(store.workspace, '.pi', 'themes'); mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'f22-synthetic.json'), JSON.stringify({ ...config, name: 'f22-synthetic', colors: { ...config.colors, accent: '#fa02ad', customMessageBg: '#010203' } })); theme = 'f22-synthetic';
  }
  if (project) {
    const state = Coordinator.initial(store.workspace, 'Synthetic layout project');
    state.slices.push({ id: 'layout-slice', status: 'completed', plan: { title: 'Layout fixture', goal: 'Inspect the workspace', requirements: [], decisionKeys: [], dependencies: [], assumptions: [], ready: false },
      result: { status: 'completed', summary: 'Synthetic fixture; no implementation executed', verification: [], discoveries: [] } }); store.save(state);
  }
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(candidate => candidate.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-never-sent');
  const bridge = await createFadeRuntime(store, {}, () => ({ build: async () => { throw new Error('No execution'); }, converse: async () => { throw new Error('No model calls'); }, close() {} }),
    { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], theme, defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } }) });
  const terminal = new LayoutTerminal(), mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace();
  for (let n = 0; n < 50 && !bridge.workspaceView; n++) await new Promise<void>(done => setTimeout(done, 20));
  const root = bridge.workspaceView; assert.ok(root);
  return { bridge, root, terminal, close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}

const hostile = '\x1b]52;c;SECRET-CLIPBOARD\x07\x1b]8;;https://hostile.invalid\x1b\\ordinary\x1b]8;;\x1b\\'
  + '\x1bPPRIVATE-DCS\x1b\\\x1b_PRIVATE-APC\x1b\\\x9dPRIVATE-C1\x9c\x1b[2J\x1b[1;1H\x1b[31m text\x1b[0m\u202E spoof';

test('G43 F22: public stock renderer and Markdown hooks filter display without changing execution or raw arguments/results', async () => {
  const f = await layoutFixture();
  try {
    const session = f.bridge.runtime.session, runner = session.extensionRunner; assert.ok(runner);
    const theme = runner.getUIContext().theme, args = { path: hostile };
    for (const name of ['read', 'grep', 'find', 'ls']) {
      const original = session.getToolDefinition(name); assert.ok(original);
      const protectedRenderers = runner.resolveToolRenderers(name, () => original); assert.ok(protectedRenderers?.renderCall && protectedRenderers.renderResult);
      const context = { args, toolCallId: 'fixture', invalidate: () => {}, lastComponent: undefined, state: {}, cwd: f.bridge.app.store.workspace,
        executionStarted: true, argsComplete: true, isPartial: false, expanded: true, showImages: false, isError: false };
      const result = { content: [{ type: 'text' as const, text: hostile }], details: {} };
      const call = protectedRenderers.renderCall(args, theme, context), output = protectedRenderers.renderResult(result, { expanded: true, isPartial: false }, theme, context);
      for (const component of [call, output]) assert.doesNotMatch(component.render(80).join('\n'), /SECRET|PRIVATE|hostile.invalid|\x1b\]|\x1b\[2J|\u202E/);
      assert.equal(args.path, hostile); assert.equal(result.content[0]?.text, hostile);
      assert.equal(session.getToolDefinition(name)?.execute, original.execute, 'stock execution function remains intact');
    }
    for (const messageType of ['user', 'assistant', 'assistant-thinking'] as const) {
      const text = runner.getMarkdownTransformers().reduce((current, transform) => transform(current, { messageType, isStreaming: true, availableWidth: 80 }), hostile);
      assert.doesNotMatch(text, /SECRET|PRIVATE|hostile.invalid|\x1b|\u202E/); assert.match(text, /ordinary/);
    }
  } finally { await f.close(); }
});

test('G43/G45 F22: presentation delegates component focus, input, mouse, key release and invalidation', () => {
  let input = '', mouse = 0, invalidated = 0;
  const original = { focused: false, wantsKeyRelease: true, render: () => [CURSOR_MARKER + hostile], handleInput: (data: string) => { input = data; },
    handleMouse: () => { mouse++; return { handled: true }; }, invalidate: () => { invalidated++; } };
  const protectedComponent = displayComponent(original); assert.ok(isFocusable(protectedComponent)); protectedComponent.focused = true;
  protectedComponent.handleInput?.('native input'); protectedComponent.handleMouse?.({ type: 'click', button: 'left', x: 0, y: 0, screenX: 0, screenY: 0, width: 80, height: 24, shift: false, alt: false, ctrl: false }); protectedComponent.invalidate();
  assert.equal(original.focused, true); assert.equal(input, 'native input'); assert.equal(mouse, 1); assert.equal(invalidated, 1); assert.equal(protectedComponent.wantsKeyRelease, true);
  assert.ok(protectedComponent.render(80)[0]?.includes(CURSOR_MARKER)); assert.doesNotMatch(protectedComponent.render(80).join('\n'), /SECRET|PRIVATE|\x1b\]/);
  assert.equal(underlyingComponent(displayComponent(protectedComponent)), original);
  assert.equal(displayJson(null), null); assert.deepEqual(displayJson({ text: hostile, child: [null, true, 1] }), { text: terminalText(hostile), child: [null, true, 1] });
  assert.match(JSON.stringify(displayValue(Array.from({ length: 200 }, () => ({ text: hostile })))), /Display items truncated/);
});

test('G45 F-TUI F22: a workspace custom theme and live public theme change repaint the mounted root', async () => {
  const previous = process.env.NO_COLOR; delete process.env.NO_COLOR;
  const f = await layoutFixture('dark', false, true);
  try {
    const runner = f.bridge.runtime.session.extensionRunner; assert.ok(runner); const ui = runner.getUIContext();
    assert.equal(ui.theme.name, 'f22-synthetic'); const custom = f.root.render(120).join('\n');
    assert.ok(custom.includes(ui.theme.getFgAnsi('accent'))); assert.ok(custom.includes(ui.theme.getBgAnsi('customMessageBg')));
    assert.equal(ui.setTheme('light').success, true); const refreshed = f.root.render(120).join('\n');
    assert.ok(refreshed.includes(ui.theme.getFgAnsi('accent'))); assert.ok(refreshed.includes(ui.theme.getBgAnsi('customMessageBg'))); assert.notEqual(refreshed, custom);
    const captures = join(f.bridge.app.store.workspace, 'captures'); mkdirSync(captures); writeFileSync(join(captures, 'custom-theme.txt'), custom); writeFileSync(join(captures, 'live-light-theme.txt'), refreshed);
    console.log(`F22 custom theme captures: ${captures}`);
  } finally { await f.close(); if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('G43/G45 F22: actual split and Fade native renderers honor Pi light/dark tokens and NO_COLOR with textual focus', async () => {
  const previous = process.env.NO_COLOR;
  try {
    for (const theme of ['dark', 'light']) for (const noColor of [false, true]) {
      if (noColor) process.env.NO_COLOR = '1'; else delete process.env.NO_COLOR;
      const f = await layoutFixture(theme);
      try {
        const runner = f.bridge.runtime.session.extensionRunner; assert.ok(runner);
        const nativeTheme = runner.getUIContext().theme;
        f.root.editors.builder.setText(hostile + ' retained draft');
        const rows = f.root.render(120), raw = rows.join('\n');
        assert.match(terminalText(raw, 500000), /BUILDER · focused/); assert.doesNotMatch(raw, /SECRET|PRIVATE|hostile.invalid|\x1b\[2J|\u202E/);
        if (noColor) assert.doesNotMatch(raw, /\x1b\[[\d;]*m/);
        else { assert.ok(raw.includes(nativeTheme.getFgAnsi('accent'))); assert.ok(raw.includes(nativeTheme.getBgAnsi('customMessageBg'))); }
        for (const type of ['fade-human', 'fade-companion', 'fade-note', 'fade-builder']) {
          const renderer = runner.getMessageRenderer(type); assert.ok(renderer);
          const view = renderer({ role: 'custom', customType: type, content: hostile + '\n[ordinary link](https://example.invalid)', display: true, timestamp: 1 }, { expanded: false, outputPad: 1 }, nativeTheme); assert.ok(view);
          const native = view.render(80).join('\n'); assert.doesNotMatch(native, /SECRET|PRIVATE|hostile.invalid|\x1b\]|\x1b\[2J|\u202E/); assert.match(native, /ordinary/);
        }
        assert.equal(f.root.editors.builder.getExpandedText(), hostile + ' retained draft');
        const captures = join(f.bridge.app.store.workspace, 'captures'); mkdirSync(captures); writeFileSync(join(captures, `${theme}-${noColor ? 'no-color' : 'color'}.txt`), raw);
        console.log(`F22 theme/native captures: ${captures}`);
      } finally { await f.close(); }
    }
  } finally { if (previous === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previous; }
});

test('G03/G46 F-TUI F22: critical draft, cursor, command selection and recovery fit real short/narrow viewport budgets', async () => {
  const f = await layoutFixture('dark', true);
  try {
    const captures = join(f.bridge.app.store.workspace, 'captures'); mkdirSync(captures);
    const draft = '中文 e\u0301 👩‍💻\n'.repeat(20) + 'END🌱 e\u0301';
    for (const [columns, rows] of [[120, 40], [80, 24], [45, 20], [30, 12], [45, 10], [45, 9], [20, 5]]) {
      f.terminal.columns = columns ?? 80; f.terminal.rows = rows ?? 24; f.terminal.resize();
      f.root.view.focus = 'builder'; f.root.editors.builder.setText(''); f.terminal.input('\x1b[200~' + draft + '\x1b[201~');
      f.root.notify('Synthetic storage unavailable', 'acceptance_rejected', 'builder');
      let screen = f.root.render(f.terminal.columns);
      assert.ok(screen.length <= f.terminal.rows - 1, `${columns}x${rows}: ${screen.length} rows`);
      for (const row of screen) assert.ok(visibleWidth(row) <= f.terminal.columns);
      assert.ok(screen.some(row => row.includes(CURSOR_MARKER)), 'focused native cursor is visible');
      assert.match(terminalText(screen.join('\n'), 500000), /END🌱|\[paste #\d+/); assert.equal(f.root.editors.builder.getExpandedText(), draft);
      if ((rows ?? 24) >= 10) { assert.match(terminalText(screen.join('\n'), 500000), /Synthetic\s+storage\s+unavailable/); assert.match(terminalText(screen.join('\n'), 500000), /edit draft|\/diagnostics/); }
      writeFileSync(join(captures, `${columns}x${rows}-draft.txt`), screen.join('\n'));
      f.root.editors.builder.setText('中文 🌱 e\u0301'); screen = f.root.render(f.terminal.columns);
      assert.match(terminalText(screen.join('\n'), 500000), /中文 🌱 e\u0301/); for (const row of screen) assert.ok(visibleWidth(row) <= f.terminal.columns);
      f.root.editors.builder.setText(''); f.terminal.input('/'); await new Promise<void>(done => setTimeout(done, 35));
      assert.equal(f.root.editors.builder.isShowingAutocomplete(), true);
      screen = f.root.render(f.terminal.columns); assert.ok(screen.length <= f.terminal.rows - 1);
      assert.ok(screen.some(row => /→\s+\S+/.test(terminalText(row, 20000))), `selected command remains visible at ${columns}x${rows}\n${terminalText(screen.join('\n'), 20000)}`);
      f.terminal.input('\x1b[B'); screen = f.root.render(f.terminal.columns);
      assert.ok(screen.some(row => /→\s+\S+/.test(terminalText(row, 20000))), `selection follows native paging at ${columns}x${rows}\n${terminalText(screen.join('\n'), 20000)}`);
      writeFileSync(join(captures, `${columns}x${rows}-menu.txt`), screen.join('\n'));
      f.terminal.input('\x1b'); assert.equal(f.root.editors.builder.isShowingAutocomplete(), false);
    }
    console.log(`F22 viewport captures: ${captures}`);
  } finally { await f.close(); }
});

test('G39/G58 F-TUI F22: source anchors survive recent-window eviction, concurrent output and width changes with a bounded pinned page', async () => {
  const f = await layoutFixture('dark', true);
  try {
    const state = f.bridge.app.coordinator?.state; assert.ok(state);
    f.root.view.mode = 'companion'; f.root.view.focus = 'companion'; f.terminal.columns = 80; f.terminal.rows = 24;
    for (let n = 0; n < 70; n++) state.conversation.push({ id: `anchor-${n}`, scope: 'session', sessionId: state.currentSessionId, role: 'companion', targetRole: 'companion', timestamp: n, text: `Anchor ${n} · 中文 e\u0301 👩‍💻 · readable original line.` });
    f.bridge.app.store.save(state); f.root.render(80); f.root.view.companionScroll = 25;
    const before = terminalText(f.root.render(80).join('\n'), 500000), originals = before.match(/Anchor \d+/g); assert.ok(originals?.length);
    for (let n = 0; n < 90; n++) state.conversation.push({ id: `incoming-${n}`, scope: 'session', sessionId: state.currentSessionId, role: 'companion', targetRole: 'companion', timestamp: 100 + n, text: `Incoming ${n} must preserve the pinned reading page.` });
    f.bridge.app.store.save(state); const after = terminalText(f.root.render(80).join('\n'), 500000);
    assert.deepEqual(after.match(/Anchor \d+/g), originals); assert.match(after, /New output/); assert.equal(f.root.view.focus, 'companion');
    for (const columns of [45, 120, 80]) {
      f.terminal.columns = columns; f.terminal.resize(); const resized = terminalText(f.root.render(columns).join('\n'), 500000);
      assert.ok(resized.includes(originals[0] ?? ''), 'logical source stays visible after wrapping changes'); assert.equal(f.root.view.focus, 'companion');
    }
    for (let n = 0; n < 200 && f.root.view.companionScroll; n++) f.terminal.input('\x1b[6~');
    const latest = terminalText(f.root.render(80).join('\n'), 500000); assert.doesNotMatch(latest, /New output/); assert.match(latest, /Incoming 89/);
    f.root.view.companionScroll = 10; f.root.render(80);
    f.terminal.columns = 45; const resizeOnly = terminalText(f.root.render(45).join('\n'), 500000); assert.doesNotMatch(resizeOnly, /New output/);
    assert.match(await f.bridge.app.inspectAsync('history', 'Anchor 0'), /Anchor 0/);
    const captures = join(f.bridge.app.store.workspace, 'captures'); mkdirSync(captures); writeFileSync(join(captures, 'anchored-before.txt'), before); writeFileSync(join(captures, 'anchored-after.txt'), after);
    console.log(`F22 anchor captures: ${captures}`);
  } finally { await f.close(); }
});

test('G13/G31/G39 F-TUI F22: native settings return and restart restore the same cold reading page without cross-session/role leakage', async () => {
  const f = await layoutFixture('dark', true), workspace = f.bridge.app.store.workspace;
  const currentView = () => f.bridge.workspaceView;
  let first = '', sessionId = '';
  try {
    const state = f.bridge.app.coordinator?.state; assert.ok(state); sessionId = state.currentSessionId;
    f.root.view.mode = 'companion'; f.root.view.focus = 'companion'; f.terminal.columns = 80; f.terminal.rows = 24;
    for (let n = 0; n < 80; n++) state.conversation.push({ id: `saved-anchor-${n}`, scope: 'session', sessionId, role: 'companion', targetRole: 'companion', timestamp: n, text: `Saved anchor ${n} · original reading page.` });
    f.bridge.app.store.save(state); f.root.render(80); f.root.view.companionScroll = 30;
    const before = terminalText(f.root.render(80).join('\n'), 500000); first = before.match(/Saved anchor \d+/)?.[0] ?? ''; assert.ok(first);
    f.root.editors.companion.setText('/settings'); f.terminal.input('\r'); await new Promise<void>(done => setTimeout(done, 50));
    assert.equal(currentView(), undefined, 'native settings owns the screen');
    for (let n = 0; n < 180; n++) state.conversation.push({ id: `advanced-${n}`, scope: 'session', sessionId, role: 'companion', targetRole: 'companion', timestamp: 100 + n, text: `Later native-dialog output ${n}` });
    f.bridge.app.store.save(state); assert.equal(state.conversation.some(message => message.text.includes(first)), false, 'original page is now cold');
    f.terminal.input('\x1b');
    for (let n = 0; n < 100 && !currentView(); n++) await new Promise<void>(done => setTimeout(done, 20));
    const returned = currentView(); assert.ok(returned);
    assert.ok(terminalText(returned.render(80).join('\n'), 500000).includes(first)); assert.equal(returned.view.focus, 'companion');
    const manager = f.bridge.runtime.session.sessionManager;
    manager.appendMessage({ role: 'user', content: 'Synthetic F22 session continuity marker', timestamp: 1 });
    const path = manager.getSessionFile(); assert.ok(path); state.sessions.companion = path; f.bridge.app.store.save(state);
    state.conversation.push(
      { id: 'foreign-session', scope: 'session', sessionId: 'another-session', role: 'companion', targetRole: 'companion', timestamp: 500, text: 'SHOULD NOT LEAK foreign session' },
      { id: 'foreign-role', scope: 'session', sessionId, role: 'companion', targetRole: 'builder', timestamp: 501, text: 'SHOULD NOT LEAK Builder pane' },
      { id: 'foreign-history', scope: 'project_history', historyReason: 'Synthetic ambiguous provenance', role: 'companion', targetRole: 'companion', timestamp: 502, text: 'SHOULD NOT LEAK project history' });
    f.bridge.app.store.save(state);
    const saved = f.bridge.app.store.loadTerminal(sessionId); assert.ok(saved?.companionReading?.pageIds.length);
    const snapshot = JSON.stringify(state); assert.ok(f.bridge.app.store.findConversations(saved.companionReading.pageIds).length); assert.equal(JSON.stringify(state), snapshot);
    assert.throws(() => f.bridge.app.store.findConversations(Array.from({ length: 65 }, () => 'id')), /64/);
  } finally { await f.close(); }
  const metadataStore = new Store(workspace); metadataStore.lock();
  try {
    metadataStore.load();
    const saved = metadataStore.loadTerminal(sessionId); assert.ok(saved?.companionReading);
    saved.companionReading.pageIds.push('foreign-session', 'foreign-role', 'foreign-history'); metadataStore.saveTerminal(saved);
  } finally { metadataStore.close(); }
  const reopened = await layoutFixture('dark', false, false, workspace);
  try {
    assert.equal(reopened.bridge.app.currentSessionId, sessionId);
    assert.ok(terminalText(reopened.root.render(120).join('\n'), 500000).includes(first)); assert.equal(reopened.root.view.focus, 'companion');
    assert.doesNotMatch(terminalText(reopened.root.render(120).join('\n'), 500000), /SHOULD NOT LEAK/);
    assert.equal(reopened.bridge.app.coordinator?.state.inputs.length, 0, 'reading restoration never replays or accepts a receipt');
    const captures = join(workspace, 'reading-captures'); mkdirSync(captures); writeFileSync(join(captures, 'restarted-page.txt'), reopened.root.render(120).join('\n'));
    console.log(`F22 restored reading capture: ${captures}`);
  } finally { await reopened.close(); }
});

test('G43 F22: display boundary removes terminal side effects and exposes bidi while preserving ordinary Unicode', () => {
  const input = hostile + '\n中文 e\u0301 👩‍💻 🌱\tend\roverwrite';
  const safe = terminalText(input, 1000);
  assert.equal(safe, 'ordinary text[U+202E] spoof\n中文 e\u0301 👩‍💻 🌱    end[CR]overwrite');
  assert.equal(visibleText(input, 1000), safe); assert.equal(terminalText(safe, 1000), safe);
  assert.doesNotMatch(safe, /[\x1b\x7f-\x9f\u202E]/);
  for (const control of ['\x1b]52;c;unterminated', '\x1bPunterminated', '\x1b[999;', '\x9dunterminated', '\x1bXunterminated']) assert.equal(terminalText('before' + control), 'before');
  assert.equal(terminalText('a🌱b', 2), 'a'); assert.equal(terminalText('a🌱b', 3), 'a🌱');
  assert.equal(terminalText('one\r\ntwo'), 'one\ntwo'); assert.ok(input.includes('SECRET-CLIPBOARD'), 'raw input remains unchanged');
});

test('G43/G46 F22: native rendered rows retain safe theme/cursor presentation and reject OSC, conceal and blink', () => {
  const safe = renderedText('\x1b[38;2;10;20;30mtext\x1b[39m' + CURSOR_MARKER + hostile + '\x1b[8mconceal\x1b[5mblink');
  assert.ok(safe.includes(CURSOR_MARKER)); assert.ok(safe.includes('\x1b[38;2;10;20;30m'));
  assert.doesNotMatch(safe, /SECRET|PRIVATE|hostile.invalid|\x1b\[[58]m|\x1b\[2J/);
  assert.equal(terminalText(CURSOR_MARKER + 'visible'), 'visible');
});

test('G43 F22: reports, live cards, status and inspections consistently sanitize raw model/tool fields', () => {
  const state = Coordinator.initial('fixture', 'Explore');
  const slice = { id: 'slice', status: 'completed' as const, plan: { title: hostile, goal: hostile, requirements: [hostile], decisionKeys: [], dependencies: [], assumptions: [], ready: false },
    result: { status: 'completed' as const, summary: hostile, verification: [hostile], discoveries: [] } };
  state.slices.push(slice);
  const outputs = [observedOutput({ content: [{ type: 'text', text: hostile }] }), toolActivity({ type: 'tool_execution_start', toolName: hostile, args: { command: hostile } }),
    outcomeCard(state, slice), builderReport(state), operationCard({ id: 'call', tool: hostile, target: hostile, output: hostile, startedAt: 1, updatedAt: 2, endedAt: 2, failed: true }, true),
    workStrip(state, 120).join('\n'), new InspectionView(hostile, () => hostile, () => {}).render(80).join('\n')];
  for (const output of outputs) { assert.doesNotMatch(output, /SECRET|PRIVATE|hostile.invalid|\x1b\]|\x1b\[2J|\u202E/); assert.doesNotMatch(terminalText(output, 500000), /\x1b/); assert.match(output, /ordinary/); }
  assert.equal(slice.result.summary, hostile, 'rendering never rewrites provenance');
});

const snapshot = (text: string, path = 'module.txt'): WorkspaceSnapshot => ({ files: [{ path, text, hash: createHash('sha256').update(text).digest('hex') }], limitations: [] });
test('G40 F-EVIDENCE F22: context diffs retain unchanged context and separate distant edits without replacing the whole file', () => {
  const lines = Array.from({ length: 100 }, (_value, n) => `Original line ${n}`), changed = [...lines]; changed[20] = 'First replacement'; changed[80] = 'Second replacement';
  const diff = renderChanges(snapshot(lines.join('\n') + '\n'), snapshot(changed.join('\n') + '\n'));
  assert.match(diff, /@@ -18,7 \+18,7 @@/); assert.match(diff, /-Original line 20\n\+First replacement/);
  assert.match(diff, /@@ -78,7 \+78,7 @@/); assert.doesNotMatch(diff, /Original line 0\n/); assert.match(diff, / Original line 19/);
  const deletion = renderChanges(snapshot('first\nsecond\n'), snapshot('first\n'));
  assert.match(deletion, /-second/); assert.doesNotMatch(deletion, /\+first/);
  assert.match(renderChanges(snapshot('text'), snapshot('text\n')), /Final newline added/);
});

test('G40/G43 F22: large and hostile comparisons stay bounded and label fallback/omissions without making deletion claims', () => {
  const old = Array.from({ length: 1200 }, (_value, n) => `Old line ${n}`).join('\n'), next = Array.from({ length: 1200 }, (_value, n) => `New line ${n}`).join('\n');
  const diff = renderChanges(snapshot(old, hostile), snapshot(next, hostile));
  assert.match(diff, /bounded replacement/); assert.ok(diff.length < 20000); assert.doesNotMatch(diff, /SECRET|PRIVATE|\x1b|\u202E/);
  assert.match(diff, /complete snapshots retained privately/);
  const omitted = renderChanges(snapshot('retained'), { files: [], limitations: ['Omitted large file'] });
  assert.match(omitted, /Creation\/deletion is unknown/); assert.doesNotMatch(omitted, /\+\+\+ \/dev\/null/);
  const view = new InspectionView(hostile, () => diff, () => {}); for (const width of [45, 80, 120]) for (const row of view.render(width)) assert.ok(visibleWidth(row) <= width);
  for (const rows of [3, 4, 5, 9, 20]) {
    const short = new InspectionView('Changes', () => diff, () => {}, false, undefined, () => rows), rendered = short.render(20);
    assert.ok(rendered.length <= Math.max(1, Math.floor(rows * .9))); assert.match(terminalText(rendered.join('\n'), 20000), /Esc closes/);
  }
});
