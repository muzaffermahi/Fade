import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';

test('FADE-12: terminal uses launch directory, restores, accepts long writing, displays intent, and quits cleanly', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-cli-'));
  const store = new Store(workspace), state = Coordinator.initial(workspace, 'A quiet notebook');
  state.conversation.push({ id: 'fixture', role: 'companion', text: 'What makes a thought worth keeping?', timestamp: 1, scope: 'session', sessionId: state.currentSessionId });
  store.save(state);
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url))],
      { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, output }));
    child.stdin.end('/write\nA long draft about unfinished thoughts.\nAnother paragraph about quiet.\n/cancel\n/status\n/intent\n/quit\n');
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Recovered your project, paused/);
  assert.match(result.output, /What makes a thought worth keeping/);
  assert.match(result.output, /Living Intent/);
  assert.ok(result.output.includes(`Workspace: ${workspace}`));
  assert.equal(existsSync(join(store.directory, 'lock')), false);
  assert.equal(store.load()?.mode, 'paused');
});

test('G05/G12 F-CONTROL: plain command help and deprecated resume route invoke no provider', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-plain-command-')); const store = new Store(workspace);
  store.save(Coordinator.initial(workspace, 'No implementation'));
  const result = await new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), fileURLToPath(new URL('../src/cli.ts', import.meta.url)), '--plain'],
      { cwd: workspace, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    child.once('error', reject); child.once('exit', code => resolve({ code, output }));
    child.stdin.end('  /\n  /unknown-command\n  /resume\n/help\n/quit\n');
  });
  assert.equal(result.code, 0, result.output); assert.match(result.output, /Unknown command/); assert.match(result.output, /Plain \/resume is deprecated; use \/continue/);
  assert.match(result.output, /\/continue/); assert.equal(store.load()?.inputs.length, 0); assert.equal(existsSync(join(store.directory, 'lock')), false);
});
