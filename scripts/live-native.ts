import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createFadeRuntime } from '../src/tui.js';
import { Store } from '../src/store.js';

// Explicit cloud selection only; no product provider/model preference.
const companionModel = process.env.FADE_COMPANION_MODEL;
const builderModel = process.env.FADE_BUILDER_MODEL;
if (!companionModel || !builderModel) throw new Error('Select both FADE_COMPANION_MODEL and FADE_BUILDER_MODEL explicitly.');
const workspace = mkdtempSync(join(tmpdir(), 'fade-native-tools-'));
const marker = `paper-crane-${randomUUID()}`;
writeFileSync(join(workspace, 'essay.md'), `The river held the moon like an unfinished thought.\nReading marker: ${marker}\n`);
const store = new Store(workspace); store.lock();
const bridge = await createFadeRuntime(store, { companionModel, builderModel });
const tools: string[] = [];
let requestStarted = 0, firstReceivedMs: number | undefined, providerTurnMs: number | undefined, passed = false, failure: string | undefined;
const off = bridge.runtime.session.subscribe(event => {
  if (event.type === 'message_update' && firstReceivedMs === undefined) firstReceivedMs = performance.now() - requestStarted;
  if (event.type === 'tool_execution_start') { tools.push(event.toolName); console.log(`Companion tool: ${event.toolName}`); }
});
const timeout = setTimeout(() => { void bridge.app.interrupt(); }, 180000);
try {
  await bridge.runtime.session.bindExtensions({});
  console.log(`Live workspace: ${workspace}`);
  requestStarted = performance.now();
  await bridge.runtime.session.prompt('Can you read essay.md using your tools? Tell me its exact Reading marker and give one specific sentence-level observation. This is an inspection request: do not edit or create any project files and do not propose another implementation slice.');
  await bridge.app.idle();
  providerTurnMs = performance.now() - requestStarted;
  const receipt = bridge.app.coordinator?.state.inputs.at(-1);
  if (receipt?.status === 'failed' || receipt?.status === 'interrupted') throw new Error(`${receipt.status}: ${receipt.error ?? 'Provider turn did not complete'}`);
  const answer = bridge.app.history().filter(m => m.role === 'companion').at(-1)?.text ?? '';
  if (!tools.some(tool => ['read', 'grep', 'find', 'ls'].includes(tool))) throw new Error('Native Companion did not inspect using read-only Pi tools.');
  if (tools.some(tool => !['read', 'grep', 'find', 'ls', 'fade_project_context', 'fade_update_intent'].includes(tool))) throw new Error('Companion used a tool outside its read-only/metadata authority.');
  if (!answer.includes(marker)) throw new Error(`Reply did not contain the file-only marker: ${answer}`);
  const coordinator = bridge.app.coordinator; if (!coordinator) throw new Error('Missing native coordinator');
  const shell = await coordinator.withCompanionExecution('explicit native check', () => bridge.runtime.session.executeBash('echo Fade-native-shell'));
  if (!shell.output.includes('Fade-native-shell') || shell.exitCode !== 0) throw new Error('Native shell command failed.');
  console.log(answer);
  console.log('LIVE PASS: real native Companion inspected the file, returned its undisclosed marker, and native shell executed.');
  passed = true;
} catch (error) { failure = error instanceof Error ? error.message : String(error); throw error; }
finally {
  clearTimeout(timeout); off(); bridge.disposeView(); await bridge.app.close(); await bridge.runtime.dispose();
  writeFileSync(join(workspace, 'evaluation.json'), JSON.stringify({ passed, failure, builderModel, companionModel, tools, firstReceivedMs, providerTurnMs,
    node: process.version, platform: process.platform, scope: 'Actual native Pi provider and explicit human shell; synthetic workspace, no physical terminal latency claim' }, null, 2));
}
