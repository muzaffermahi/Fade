import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';

const builderModel = process.env.FADE_BUILDER_MODEL, companionModel = process.env.FADE_COMPANION_MODEL;
if (!builderModel || !companionModel) throw new Error('Explicitly select both role models for this cloud conversation test.');
const workspace = mkdtempSync(join(tmpdir(), 'fade-exchanges-'));
writeFileSync(join(workspace, 'essay.md'), 'I kept the letter because the silence after it felt heavier than the paper.');
const store = new Store(workspace); store.lock();
const bridge = await createFadeRuntime(store, { builderModel, companionModel });
const timeout = setTimeout(() => { void bridge.app.interrupt(); }, 240000);
async function exchange(text: string) {
  const before = bridge.app.history().filter(m => m.role === 'companion').length;
  console.log(`\nHuman: ${text}`);
  await bridge.runtime.session.prompt(text);
  for (let i = 0; i < 1200 && bridge.app.history().filter(m => m.role === 'companion').length <= before; i++) await new Promise(done => setTimeout(done, 100));
  const answer = bridge.app.history().filter(m => m.role === 'companion').at(-1);
  if (!answer || bridge.app.history().filter(m => m.role === 'companion').length <= before) throw new Error('No saved Companion reply.');
  console.log(`Companion: ${answer.text}`);
}
try {
  await bridge.runtime.session.bindExtensions({});
  console.log(`Exchange workspace: ${workspace}`);
  const first = 'Build only essay-review.mjs exporting analyze(text) with wordCount and sentenceCount, plus a dependency-free test, and run it. It should handle empty text. No UI or dependencies. While the Builder does that, read essay.md and tell me one worthwhile observation about its writing. Do not propose a second slice yet.';
  const firstReply = exchange(first);
  for (let i = 0; i < 100 && !readFileSync(join(store.directory, 'builder-events.jsonl'), { encoding: 'utf8', flag: 'a+' }).includes('tool_execution_start'); i++) await new Promise(done => setTimeout(done, 100));
  await bridge.runtime.session.prompt('/builder Please report the exact empty-text test result, and explain any limitation in sentence counting. Keep this slice unchanged.');
  await firstReply;
  await exchange('Give me two alternative versions of that sentence: one restrained and one more lyrical. Explain the tradeoff. Do not edit the essay or start another slice.');
  await bridge.app.idle();
  await bridge.runtime.session.prompt('/reports');
  await exchange('What did the Builder actually finish and test? Relate that to the writing observation; distinguish counts from actual writing quality. Do not start more work.');
  const notes = bridge.app.coordinator?.state.builderMessages ?? [];
  const completed = bridge.app.coordinator?.state.slices.filter(s => s.status === 'completed') ?? [];
  if (!completed.length) throw new Error('Builder did not finish.');
  if (!notes.some(n => n.status === 'received')) throw new Error(`No Builder receipt: ${JSON.stringify(notes)}`);
  const report = bridge.runtime.session.messages.findLast(m => m.role === 'custom' && m.customType === 'fade-note' && String(m.content).includes('Checks reported'));
  if (!report) throw new Error('Readable report did not reach the native transcript.');
  console.log(`\nBuilder notes: ${notes.map(n => `${n.id.slice(0, 8)} ${n.status}`).join(', ')}`);
  console.log(`Builder report: ${completed.at(-1)?.result?.summary}`);
  console.log('LIVE EXCHANGES PASS: three real Companion exchanges, concurrent Builder steering receipt, readable reports, and tested implementation.');
} finally { clearTimeout(timeout); await bridge.app.close(); await bridge.runtime.dispose(); }
