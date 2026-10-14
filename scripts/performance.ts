import { mkdtempSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir, cpus, platform, arch } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { InteractiveMode, ModelRuntime, SettingsManager, SessionManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import type { Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';
import { Coordinator } from '../src/coordinator.js';
import { IMAGE_LIMITS } from '../src/payloads.js';
import { terminalText } from '../src/terminal-text.js';
class MeasuredTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  private pending: { expected: string; started: number; resolve: (latency: number) => void } | undefined;
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
  write(text: string) {
    this.output = (this.output + text).slice(-200000);
    if (this.pending && text.includes(this.pending.expected)) { const pending = this.pending; this.pending = undefined; pending.resolve(performance.now() - pending.started); }
  }
  measure(expected: string, action: () => void): Promise<number> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending = undefined; reject(new Error('No received render for ' + expected + ' within five seconds')); }, 5000);
      this.pending = { expected, started: performance.now(), resolve: latency => { clearTimeout(timer); resolve(latency); } }; action();
    });
  }
}
const diskBytes = (directory: string): number => readdirSync(directory, { withFileTypes: true }).reduce((total, entry) => {
  const path = join(directory, entry.name); return total + (entry.isDirectory() ? diskBytes(path) : statSync(path).size);
}, 0);
const tick = () => new Promise<void>(done => setTimeout(done, 25));
const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] ?? 0;
process.env.PI_OFFLINE = '1'; process.env.PI_SKIP_VERSION_CHECK = '1';
const evidence = mkdtempSync(join(tmpdir(), 'fade-performance-')), workspace = join(evidence, 'workspace');
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const model = runtime.getModels().find(candidate => candidate.provider === 'anthropic'); if (!model) throw new Error('No fixture model');
await runtime.setRuntimeApiKey(model.provider, 'fixture-never-sent');
const startup: number[] = [], echo: number[] = [], activity: number[] = [], completion: number[] = [];
const loadSamples: { receipts: number; rss: number; heap: number; diskBytes: number; metrics: ReturnType<Store['storageMetrics']> }[] = [];
let newestId = '', oldestId = '', totalToolEvents = 0;
let finalStorage: ReturnType<Store['storageMetrics']> | undefined;
for (let run = 0; run < 3; run++) {
  const started = performance.now();
  const store = new Store(workspace); store.lock(); if (!store.load()) store.save(Coordinator.initial(store.workspace, 'Synthetic long-session performance'));
  const settingsManager = SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } });
  const bridge = await createFadeRuntime(store, {}, () => ({ build: async () => { throw new Error('No model calls'); }, converse: async () => ({ reply: 'Synthetic response', evidence: [], openQuestions: [], next: null }), close() {} }), { modelRuntime: runtime, settingsManager });
  const c = bridge.app.coordinator; if (!c) throw new Error('Missing coordinator');
  if (run === 0) {
    const bytes = Buffer.alloc(IMAGE_LIMITS.each); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
    const largest = { type: 'image' as const, mimeType: 'image/png', data: bytes.toString('base64') }; store.validateNewImages([largest, largest]);
    const images = store.referenceImages([largest, largest]);
    for (let n = 0; n < 1000; n++) {
      const id = c.accept('Synthetic receipt ' + n + ' · ' + 'bounded history '.repeat(60), { attachments: n % 100 === 0 ? images : [] });
      if (!oldestId) oldestId = id; newestId = id; c.cancelInput(id);
      if ((n + 1) % 250 === 0) { const memory = process.memoryUsage(); loadSamples.push({ receipts: n + 1, rss: memory.rss, heap: memory.heapUsed, diskBytes: diskBytes(store.directory), metrics: store.storageMetrics() }); writeFileSync(join(evidence, 'load-samples.json'), JSON.stringify(loadSamples, null, 2)); console.log('Built synthetic receipts: ' + (n + 1) + ' · ' + evidence); }
    }
    const sliceId = randomUUID(); c.state.slices.push({ id: sliceId, status: 'completed', plan: { title: 'Synthetic stream fixture', goal: 'Measure rendering only', requirements: ['Synthetic measurement'],
      decisionKeys: [], acceptanceChecks: [{ kind: 'manual', criterion: 'Synthetic fixture has no production verification claim' }], dependencies: [], assumptions: [], ready: false }, lastSequence: 0 });
    for (let n = 0; n < 300; n++) {
      const output = 'Synthetic operation ' + n + '\n' + 'retained raw output '.repeat(1500), operationId = 'operation-' + n;
      const startEvent = { type: 'tool_execution_start', toolCallId: operationId, toolName: 'read', args: { path: 'synthetic.txt' } };
      const endEvent = { type: 'tool_execution_end', toolCallId: operationId, toolName: 'read', isError: false, result: { content: [{ type: 'text', text: output }] } };
      store.event({ sliceId, event: startEvent }); store.event({ sliceId, event: endEvent });
      c.state.workEvents.push({ sliceId, sequence: n * 2 + 1, type: 'tool_start', phase: 'inspecting', operationId, toolName: 'read', timestamp: n, payload: startEvent },
        { sliceId, sequence: n * 2 + 2, type: 'tool_end', phase: 'inspecting', operationId, toolName: 'read', timestamp: n, payload: endEvent, isError: false });
      c.state.verificationEvidence.push({ sliceId, sequence: n * 2 + 2, operationId, toolName: 'read', timestamp: n, isError: false, input: startEvent, result: endEvent.result });
      const slice = c.state.slices[0]; if (slice) slice.lastSequence = n * 2 + 2; c.state.revision++; store.save(c.state); totalToolEvents += 2;
    }
    store.saveTerminal({ sessionId: c.state.currentSessionId, mode: 'fade', focus: 'builder', builderDraft: '', companionDraft: '', builderAttachments: images, companionAttachments: [], builderScroll: 0, companionScroll: 0 });
    const sessionsDir = store.sessionDirectory('builder');
    for (let n = 0; n < 100; n++) {
      const manager = SessionManager.create(store.workspace, sessionsDir);
      manager.appendMessage({ role: 'user', content: `Synthetic completed Builder session ${n}`, timestamp: n });
      manager.appendCustomMessageEntry('performance-fixture', `Synthetic completed Builder session ${n}`, false);
      const path = manager.getSessionFile(); if (!path || !statSync(path).isFile()) throw new Error('Missing synthetic Pi session file'); c.state.sessions.builders.push(path);
    }
    assert.equal(readdirSync(sessionsDir).filter(name => name.endsWith('.jsonl')).length, 100);
    store.save(c.state); assert.equal(c.state.sessions.builders.length, 32);
    assert.match(store.readMetadataPage('builderSession'), /builderSession/);
    store.checkpoint(c.state);
    assert.equal(store.findInput(oldestId)?.text.startsWith('Synthetic receipt 0'), true); assert.equal(store.findInput(newestId)?.text.startsWith('Synthetic receipt 999'), true);
    assert.equal(c.state.inputs.length, 128); assert.ok(c.state.workEvents.length <= 256); assert.equal(c.state.verificationEvidence.length, 128);
  }
  const terminal = new MeasuredTerminal(), mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  try {
    await mode.init(); void mode.run(); void bridge.openWorkspace(); for (let attempt = 0; attempt < 100 && !bridge.workspaceView; attempt++) await tick();
    const root = bridge.workspaceView; if (!root) throw new Error('Split workspace did not mount');
    if (run > 0) startup.push(performance.now() - started);
    assert.equal(root.view.mode, 'fade'); assert.match(root.render(120).join('\n'), /BUILDER/); assert.match(root.render(120).join('\n'), /COMPANION/);
    if (run === 2) {
      root.view.focus = 'builder'; root.editors.builder.setText('');
      bridge.app.activity.begin('companion', c.state.currentSessionId, 'concurrent-fixture');
      for (let n = 0; n < 50; n++) {
        const character = String.fromCharCode(0x4e00 + n); echo.push(await terminal.measure(character, () => terminal.input(character)));
        const text = 'Concurrent ' + n; activity.push(await terminal.measure(text, () => bridge.app.activity.observe('companion', { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] } })));
        assert.equal(root.view.focus, 'builder'); assert.ok(root.render(120).join('\n').includes(character));
      }
      root.openAttachments(); terminal.input('\x1b'); await tick(); assert.equal(root.view.focus, 'builder');
      for (let n = 0; n < 10; n++) { const text = 'Completed measurement ' + n; completion.push(await terminal.measure(text, () => root.notify(text))); assert.ok(root.render(120).join('\n').includes(text)); }
      for (let n = 0; n < 80; n++) c.state.conversation.push({ id: `performance-reading-${n}`, scope: 'session', sessionId: c.state.currentSessionId,
        role: 'companion', targetRole: 'companion', timestamp: n, text: `Reading marker ${n} · 中文 e\u0301 👩‍💻 · retained conversation.` });
      store.save(c.state); root.render(120); root.view.companionScroll = 25;
      const reading = terminalText(root.render(120).join('\n'), 500000).match(/Reading marker \d+/)?.[0]; assert.ok(reading);
      for (let n = 0; n < 30; n++) {
        bridge.app.activity.observe('companion', { type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: `Concurrent reading update ${n}` }] } });
        terminal.input('a'); await tick();
        assert.equal(root.view.focus, 'builder'); assert.ok(terminalText(root.render(120).join('\n'), 500000).includes(reading));
      }
      for (const [columns, rows] of [[120, 40], [80, 24], [45, 20]]) {
        if (columns === undefined || rows === undefined) throw new Error('Missing viewport fixture');
        terminal.columns = columns; terminal.rows = rows; terminal.resize(); const screen = root.render(columns);
        assert.ok(screen.length < rows); assert.equal(root.view.focus, 'builder');
        root.view.focus = 'companion'; assert.ok(terminalText(root.render(columns).join('\n'), 500000).includes(reading)); root.view.focus = 'builder';
        writeFileSync(join(evidence, `split-current-${columns}x${rows}.txt`), screen.join('\n'));
      }
      terminal.columns = 120; terminal.rows = 40; terminal.resize();
      assert.match(await bridge.app.inspectAsync('history', 'Synthetic receipt 0'), /Synthetic receipt 0/); assert.match(await bridge.app.inspectAsync('inputs', oldestId), /Synthetic receipt 0/);
      writeFileSync(join(evidence, 'split-120x40.ansi'), terminal.output); writeFileSync(join(evidence, 'split-current-screen.txt'), root.render(120).join('\n'));
      finalStorage = store.storageMetrics();
    }
  } finally { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); }
}
const result = { hardware: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: platform(), arch: arch(), node: process.version },
  scope: 'Actual Pi split workspace with synthetic transport, 1000 receipts, 30MiB decoded draft payload, 600 tool lifecycle records, 100 retained Pi session files and concurrent role output; startup includes Store open/load/recovery; no provider/physical terminal/IME measurement',
  receipts: 1000, toolEvents: totalToolEvents, piSessionFiles: 100, warmUsableStartupMs: startup, inputEchoP95Ms: p95(echo), activityP95Ms: p95(activity), activityMaxMs: Math.max(...activity),
  completionMaxMs: Math.max(...completion), loadSamples, finalStorage, finalDiskBytes: diskBytes(join(workspace, '.fade')), finalMemory: process.memoryUsage(),
  targets: { startup: 2000, inputEchoP95: 50, activity: 250, completion: 250, rssGrowthAfter250: 128 * 1024 * 1024 } };
writeFileSync(join(evidence, 'metrics.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ ...result, evidence }, null, 2));
const first = loadSamples[0], last = loadSamples.at(-1);
if (startup.some(ms => ms > 2000) || p95(echo) >= 50 || Math.max(...activity) > 250 || Math.max(...completion) > 250
  || (first && last && last.rss - first.rss > result.targets.rssGrowthAfter250)) process.exitCode = 1;
