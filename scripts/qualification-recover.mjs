import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidate = JSON.parse(readFileSync(join(root, 'releases/candidate.json'), 'utf8'));
if (process.env.FADE_CANDIDATE_SHA256 !== candidate.sha256 || createHash('sha256').update(readFileSync(candidate.archive)).digest('hex') !== candidate.sha256) throw new Error('Candidate archive/hash mismatch');
if (!process.env.FADE_PACKAGE_ROOT || !process.env.FADE_RECOVERY_WORKSPACE) throw new Error('Explicit installed package and rehearsal workspace required');
const packageRoot = resolve(process.env.FADE_PACKAGE_ROOT), workspace = resolve(process.env.FADE_RECOVERY_WORKSPACE);
const prior = JSON.parse(readFileSync(join(workspace, 'evaluation.json'), 'utf8'));
if (prior.candidateSha256 !== candidate.sha256 || prior.packageRoot !== packageRoot || prior.passed !== false) throw new Error('Require a failed rehearsal against this installed artifact');
const builderModel = process.env.FADE_BUILDER_MODEL, companionModel = process.env.FADE_COMPANION_MODEL;
if (!builderModel || !companionModel || builderModel !== prior.builderModel || companionModel !== prior.companionModel) throw new Error('Declare the same role models as the failed rehearsal');
const { Coordinator } = await import(pathToFileURL(join(packageRoot, 'dist/coordinator.js')).href);
const { Store } = await import(pathToFileURL(join(packageRoot, 'dist/store.js')).href);
const { PiAgents } = await import(pathToFileURL(join(packageRoot, 'dist/pi.js')).href);
const { verifiedSlice } = await import(pathToFileURL(join(packageRoot, 'dist/checks.js')).href);
const modulePath = join(workspace, 'notebook.mjs'), before = readFileSync(modulePath, 'utf8');
const store = new Store(workspace); store.lock();
let state;
try { state = store.load(); if (!state) throw new Error('Saved project required'); }
catch (error) { store.close(); throw error; }
const originalPlans = JSON.stringify(state.slices.map(slice => ({ id: slice.id, plan: slice.plan })));
const events = [], started = Date.now();
const c = new Coordinator(state, store, new PiAgents(store, state, { builderModel, companionModel }), notice => { events.push({ timestamp: Date.now(), ...notice }); console.log(`${notice.role}: ${notice.text}`); });
const timeout = setTimeout(() => { void c.close(); }, 1200000);
let passed = false, failure, pausedRecovery = false, correctionReceipt;
try {
  c.recover(); const sequences = state.workEvents.map(event => event.sequence);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(state.mode, 'paused'); assert.equal(state.ownership.owner, null);
  assert.deepEqual(state.workEvents.map(event => event.sequence), sequences);
  assert.equal(readFileSync(modulePath, 'utf8'), before); pausedRecovery = true;
  console.log('RECOVERY_PAUSED: no task or file change before explicit continuation');
  const note = await c.messageBuilder('Explicit acceptance correction for the existing notebook slices: Pi Bash already runs in the workspace. Run the acceptance command exactly as declared, without cd, wrappers, prefixes or combined commands: node --check notebook.mjs for the foundation, and node notebook.test.mjs for the search slice. Preserve the existing addNote implementation and the existing bounded plans. The earlier compound command did not satisfy acceptance. Rerun the exact required check before reporting completion.');
  correctionReceipt = note.id; c.resume(); await c.idle();
  assert.equal(JSON.stringify(state.slices.map(slice => ({ id: slice.id, plan: slice.plan }))), originalPlans);
  assert.equal(state.slices.filter(slice => slice.status === 'completed' && verifiedSlice(slice)).length, 2);
  assert.ok(existsSync(join(workspace, 'notebook.test.mjs')));
  execFileSync(process.execPath, ['--check', modulePath]);
  execFileSync(process.execPath, ['--input-type=module', '-e', "import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);const before=['First Thought'];assert.deepEqual(m.addNote(before,'Second thought'),['First Thought','Second thought']);assert.deepEqual(before,['First Thought']);assert.deepEqual(m.searchNotes(['First Thought','another','THOUGHT'],'thought'),['First Thought','THOUGHT']);assert.deepEqual(m.searchNotes([],'x'),[]);console.log('INDEPENDENT_CHECK_OK');", modulePath], { stdio: 'inherit' });
  assert.equal(state.builderMessages.find(note => note.id === correctionReceipt)?.status, 'received');
  passed = true; console.log('ASSISTED RECOVERY PASS: paused restart, durable correction, exact observed checks, unchanged plans, automatic dependent work and independent behavior');
} catch (error) { failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; console.error(`ASSISTED RECOVERY FAIL: ${failure}`); }
finally {
  clearTimeout(timeout); await c.close();
  writeFileSync(join(workspace, 'recovery-evaluation.json'), JSON.stringify({ passed, failure, pausedRecovery, correctionReceipt, builderModel, companionModel, candidateSha256: candidate.sha256, packageRoot, elapsedMs: Date.now() - started,
    node: process.version, platform: process.platform, originalFailure: prior.failure, slices: state.slices.map(slice => ({ id: slice.id, status: slice.status, checks: slice.checks })), events,
    scope: 'Explicit assisted recovery through installed public adapters; original failed evaluation preserved; no physical terminal/unassisted participant claim' }, null, 2));
}
