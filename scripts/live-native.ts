import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
const off = bridge.runtime.session.subscribe(event => { if (event.type === 'tool_execution_start') { tools.push(event.toolName); console.log(`Companion tool: ${event.toolName}`); } });
const timeout = setTimeout(() => { void bridge.app.interrupt(); }, 180000);
try {
  await bridge.runtime.session.bindExtensions({});
  console.log(`Live workspace: ${workspace}`);
  await bridge.runtime.session.prompt('Can you read essay.md using your tools? Tell me its exact Reading marker and give one specific sentence-level observation. This is an inspection request: do not edit or create any project files and do not propose another implementation slice.');
  await bridge.app.idle();
  const answer = bridge.app.history().filter(m => m.role === 'companion').at(-1)?.text ?? '';
  if (!tools.some(tool => tool === 'read' || tool === 'bash')) throw new Error('Native Companion did not inspect using Pi tools.');
  if (!answer.includes(marker)) throw new Error(`Reply did not contain the file-only marker: ${answer}`);
  const shell = await bridge.runtime.session.executeBash('echo Fade-native-shell');
  if (!shell.output.includes('Fade-native-shell') || shell.exitCode !== 0) throw new Error('Native shell command failed.');
  console.log(answer);
  console.log('LIVE PASS: real native Companion inspected the file, returned its undisclosed marker, and native shell executed.');
} finally { clearTimeout(timeout); off(); await bridge.app.close(); await bridge.runtime.dispose(); }
