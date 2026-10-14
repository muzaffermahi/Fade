import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diagnosticReport, diagnosticJson, doctorText, exportDiagnostic, supportedNode } from '../src/diagnostics.js';
import { Coordinator } from '../src/coordinator.js';
import { FadeApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { routeInput } from '../src/commands.js';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';

test('G55/G57 F24: diagnostics copy only validated allowlisted metadata and never expose secret/private content', () => {
  const state = Coordinator.initial('C:/PRIVATE-PATH-CANARY', 'PRIVATE-CONTENT-CANARY');
  state.inputs.push({ id: 'PRIVATE-ID-CANARY', sessionId: state.id, role: 'companion', mode: 'followUp', text: 'PRIVATE-CONTENT-CANARY', attachments: [], status: 'failed', error: 'SECRET-KEY-CANARY', timestamp: 1, updatedAt: 1, attempts: 1, edits: [] });
  const before = JSON.stringify(state), report = diagnosticReport(state, { companionModel: 'https://SECRET-KEY-CANARY@private-model.invalid' }, true, 2,
    { builderAuthConfigured: null, companionAuthConfigured: false, bashAvailable: false }, 0);
  const bytes = diagnosticJson(report); assert.doesNotMatch(bytes, /PRIVATE|SECRET|private-model|https|C:\//); assert.equal(JSON.stringify(state), before);
  assert.equal(report.state.failedInputs, 1); assert.equal(report.state.storageFailureReported, true); assert.equal(report.models.companionSelected, true);
  assert.match(doctorText(report), /Bash: missing/); assert.match(doctorText(report), /repair and restart/); assert.match(doctorText(report), /No provider call/);
  assert.throws(() => diagnosticJson({ ...report, privateText: 'CANARY' }), /validation|properties|unexpected|invalid/i);
  assert.equal(supportedNode('v22.19.0'), true); assert.equal(supportedNode('v24.14.1'), true); assert.equal(supportedNode('v22.18.0'), false); assert.equal(supportedNode('v20.19.0'), false); assert.equal(supportedNode('garbage'), false);
});

test('G57/F-CONTINUITY F24: explicit export is contained, exclusive and rejects symlink escapes and protected state', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-diagnostic-')), outside = mkdtempSync(join(tmpdir(), 'fade-diagnostic-outside-'));
  const report = diagnosticReport(undefined, {}, false, 0, { builderAuthConfigured: null, companionAuthConfigured: null, bashAvailable: true }, 0);
  const target = exportDiagnostic(workspace, 'report.json', report); assert.equal(readFileSync(target, 'utf8'), diagnosticJson(report));
  assert.throws(() => exportDiagnostic(workspace, 'report.json', report), /EEXIST/); assert.equal(readFileSync(target, 'utf8'), diagnosticJson(report));
  for (const path of ['../escape.json', join(outside, 'escape.json'), '.fade/journal.jsonl', '.git/config', 'bad\0.json']) assert.throws(() => exportDiagnostic(workspace, path, report));
  symlinkSync(outside, join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportDiagnostic(workspace, 'escape/report.json', report), /escapes/); assert.deepEqual(readdirSync(outside), []);
  mkdirSync(join(workspace, '.fade')); symlinkSync(join(workspace, '.fade'), join(workspace, 'state-alias'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportDiagnostic(workspace, 'state-alias/report.json', report), /protected/);
  writeFileSync(join(workspace, 'existing.json'), 'Original private file'); assert.throws(() => exportDiagnostic(workspace, 'existing.json', report), /EEXIST/); assert.equal(readFileSync(join(workspace, 'existing.json'), 'utf8'), 'Original private file');
});

test('G05/G55/G57 F24: doctor and bug-report commands preview locally, export only on request and never accept a receipt/call a provider', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-support-'))); store.lock(); let calls = 0; const notices: string[] = [];
  const app = new FadeApp(store, {}, notice => notices.push(notice.text), () => {}, () => ({ build: async () => { throw new Error('No implementation'); },
    converse: async () => { calls++; throw new Error('No model call'); }, close() {} }));
  try {
    const before = readdirSync(store.workspace); await app.command('doctor', ''); await app.command('bug-report', '');
    assert.deepEqual(readdirSync(store.workspace), before); assert.equal(app.coordinator, undefined); assert.equal(calls, 0); assert.ok(notices.some(text => text.includes('Preview only')));
    await app.command('bug-report', 'export report.json'); assert.ok(readFileSync(join(store.workspace, 'report.json'), 'utf8').includes('schemaVersion')); assert.ok(notices.some(text => text.includes('Nothing was uploaded')));
    await assert.rejects(app.command('bug-report', 'upload somewhere'), /preview|export/); await assert.rejects(app.command('bug-report', 'export ../outside.json'), /below/);
    await assert.rejects(app.command('bug-report', 'export report.json'), /EEXIST/); assert.equal(calls, 0); assert.equal(app.coordinator, undefined);
    assert.equal(routeInput('/doctor', 'split').kind, 'command'); assert.equal(routeInput('/bug-report export report.json', 'plain').kind, 'command');
  } finally { await app.close(); }
});

test('F-OWNERSHIP/G57 F24: preview is read-only while explicit export quiesces Builder and preserves partial work', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-export-lease-'))); store.lock(); let aborted = false;
  const app = new FadeApp(store, {}, () => {}, () => {}, () => ({
    converse: async (_state, text) => ({ reply: 'Synthetic accepted request', evidence: [{ key: 'work', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
      title: 'Synthetic work', goal: text, requirements: [text], acceptanceChecks: ['Inspect partial work'], decisionKeys: ['work'], dependencies: [], assumptions: [], ready: true } }),
    build: async (_slice, signal) => new Promise(resolve => {
      writeFileSync(join(store.workspace, 'partial.txt'), 'Retained partial work');
      signal.addEventListener('abort', () => { assert.equal(readdirSync(store.workspace).includes('report.json'), false); aborted = true; resolve({ status: 'blocked', summary: 'Interrupted', verification: [], discoveries: [] }); }, { once: true });
    }), close() {},
  }));
  try {
    await app.submit('Implement the synthetic partial work'); assert.equal(app.coordinator?.state.ownership.owner, 'builder');
    const revision = app.coordinator?.state.revision; await app.command('bug-report', ''); assert.equal(app.coordinator?.state.revision, revision); assert.equal(aborted, false);
    await app.command('bug-report', 'export report.json'); assert.equal(aborted, true); assert.equal(app.coordinator?.state.ownership.owner, null); assert.equal(app.coordinator?.state.mode, 'paused');
    assert.equal(readFileSync(join(store.workspace, 'partial.txt'), 'utf8'), 'Retained partial work'); assert.ok(readFileSync(join(store.workspace, 'report.json'), 'utf8').includes('schemaVersion'));
  } finally { await app.close(); }
});

class DiagnosticTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(text: string) { this.output = (this.output + text).slice(-200000); } moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
test('G55/G57 F-TUI F24: native diagnostic inspections/export show locally and append no report/path to model context', async () => {
  process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-diagnostic-ui-'))); store.lock(); let calls = 0;
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(candidate => candidate.provider === 'anthropic'); assert.ok(model); await modelRuntime.setRuntimeApiKey(model.provider, 'fixture-never-sent');
  const bridge = await createFadeRuntime(store, {}, () => ({ build: async () => { throw new Error('No implementation'); }, converse: async () => { calls++; throw new Error('No model call'); }, close() {} }),
    { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id }) });
  const terminal = new DiagnosticTerminal(), mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  const tick = () => new Promise<void>(resolve => setTimeout(resolve, 30));
  try {
    await mode.init(); void mode.run(); void bridge.openWorkspace(); for (let n = 0; n < 100 && !bridge.workspaceView; n++) await tick();
    const root = bridge.workspaceView; assert.ok(root); root.view.focus = 'companion'; root.editors.builder.setText('PRIVATE-DRAFT-CANARY');
    const before = JSON.stringify(bridge.runtime.session.messages);
    for (const command of ['/doctor', '/bug-report', '/bug-report export report.json']) {
      root.editors.companion.setText(command); terminal.input('\r'); await tick(); await tick();
      assert.equal(calls, 0); assert.equal(JSON.stringify(bridge.runtime.session.messages), before); terminal.input('\x1b'); await tick();
      assert.equal(root.editors.builder.getExpandedText(), 'PRIVATE-DRAFT-CANARY'); assert.equal(root.view.focus, 'companion');
    }
    assert.match(terminal.output, /No provider call/); assert.match(terminal.output, /Nothing was uploaded/);
    assert.doesNotMatch(readFileSync(join(store.workspace, 'report.json'), 'utf8'), /PRIVATE|fixture-never-sent|fade-diagnostic-ui|claude/);
    assert.equal(bridge.app.coordinator, undefined);
  } finally { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); }
});
