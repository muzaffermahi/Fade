import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';

class CaptureTerminal implements Terminal {
  columns = Number(process.env.COLS ?? 120); rows = Number(process.env.ROWS ?? 40); kittyProtocolActive = false; output = '';
  input: (data: string) => void = () => {}; resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() {} async drainInput() {} write(data: string) { this.output += data; }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {}
  setTitle() {} setProgress() {}
}
const tick = () => new Promise<void>(r => setTimeout(r, 40));
let n = 0;
const store = new Store(mkdtempSync(join(tmpdir(), 'fade-debug-'))); store.lock();
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
const model = modelRuntime.getModels().find(m => m.provider === 'anthropic')!;
await modelRuntime.setRuntimeApiKey(model.provider, 'fixture');
const settingsManager = SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, retry: { enabled: false } });
const bridge = await createFadeRuntime(store, {}, () => ({
  build: async (_s, signal) => new Promise((_res, rej) => signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true })),
  converse: async (_state, text) => text.startsWith('Build')
    ? { reply: 'Building plan.', evidence: [{ key: 'core', text, quote: text, kind: 'decision' }], openQuestions: [], next: { title: 'Core notes app', goal: text, requirements: ['r'], acceptanceChecks: ['node --check x.mjs'], decisionKeys: ['core'], dependencies: [], assumptions: [], ready: true } }
    : { reply: `REPLY_${++n}_START\n` + Array.from({ length: 8 }, (_, i) => `  line ${i} of turn ${n}`).join('\n') + `\nREPLY_${n}_END`, evidence: [], openQuestions: [], next: null }, close() {},
}), { modelRuntime, settingsManager });
const terminal = new CaptureTerminal();
const mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
try {
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
  const root = () => bridge.workspaceView!;
  terminal.input('\x1b[200~Build a local notes app with an editor.\x1b[201~'); terminal.input('\r'); await tick(); await tick();
  for (const t of ['one', 'two', 'three']) {
    terminal.input(`\x1b[200~${t}\x1b[201~`); terminal.input('\r'); await tick(); await tick(); await tick(); await tick();
  }
  const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const show = (label: string) => {
    const out = strip(root().render(terminal.columns).join('\n'));
    console.log(label, '| scroll companion:', root().view.companionScroll, '| REPLY_1:', out.includes('REPLY_1_END'), 'REPLY_2:', out.includes('REPLY_2_END'), 'REPLY_3:', out.includes('REPLY_3_END'));
  };
  show('after 3 turns');
  root().view.companionScroll = 999; terminal.input('\x1b[5~'); await tick();
  show('after pageUp');
  root().view.companionScroll = 999; terminal.input('\x1b[5~'); await tick();
  show('after pageUp x2');
  console.log('--- mode at width', terminal.columns, '---');
  for (const [key, label] of [['\x1b1', 'builder'], ['\x1b2', 'companion'], ['\x1b3', 'fade']] as const) {
    terminal.input(key); await tick();
    const out = strip(root().render(terminal.columns).join('\n'));
    const lines = root().render(terminal.columns);
    const widths = lines.map(l => visibleWidth(l));
    console.log(label, '=> mode:', root().view.mode, 'focus:', root().view.focus, '| BUILDER:', out.includes('BUILDER'), 'COMPANION:', out.includes('COMPANION'),
      '| lines:', lines.length, '/', terminal.rows, 'maxw:', Math.max(...widths), '/', terminal.columns, 'overflow:', lines.length > terminal.rows || Math.max(...widths) > terminal.columns);
  }
} finally { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); }
