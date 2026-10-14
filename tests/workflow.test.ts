import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, authorizesImplementation, type Agents } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import type { CompanionReply, BuilderResult } from '../src/contracts.js';
const done: BuilderResult = { status: 'completed', summary: 'Changed file', verification: ['Model claims success'], discoveries: [] };
const proposal = (text: string): CompanionReply => ({ reply: 'I will develop that.', evidence: [{ key: 'change', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
  title: 'Requested change', goal: text, requirements: [text], acceptanceChecks: ['node test.mjs'], decisionKeys: ['change'], dependencies: [], assumptions: [], ready: true,
} });
test('F-INTENT: late draft revalidates completed dependencies once without invented human decisions', async () => {
  let builds = 0, reconciliations = 0;
  const { c } = fixture({ build: async (_slice, _signal, emit) => { builds++; emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'check', args: { command: 'node test.mjs' } }); emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'check', isError: false, result: { content: [{ type: 'text', text: 'Observed fixture success' }] } }); return done; }, converse: async (state, text) => {
    if (text === 'Implement this change') return proposal(text);
    const answer = proposal('Implement this change'); answer.evidence = [];
    assert.ok(answer.next); const completed = state.slices.find(s => s.status === 'completed'); assert.ok(completed);
    answer.next.dependencies = [completed.id]; answer.next.title = 'Future slice'; answer.next.ready = false;
    if (!text) reconciliations++;
    return answer;
  }, close() {} });
  await c.talk('Implement this change'); await c.idle();
  await c.talk('Develop the next slice'); await c.idle();
  assert.equal(builds, 1); assert.equal(reconciliations, 1);
  assert.equal(c.state.slices.at(-1)?.status, 'draft');
  assert.equal(c.state.intent.decisions.length, 1); await c.close();
});
function fixture(agents: Agents) { const store = new Store(mkdtempSync(join(tmpdir(), 'fade-workflow-'))); const c = new Coordinator(Coordinator.initial(store.workspace, 'A project'), store, agents); return { c, store }; }

test('F09: build a discussed plan retrieves planning context but discussion alone cannot authorize it', async () => {
  let builds = 0;
  const discussed = 'What if we made a local notes module with immutable arrays?';
  const request = 'Build the thing I discussed with Companion.';
  const { c } = fixture({ build: async slice => { builds++; assert.deepEqual(slice.plan.requirements, ['Local notes module with immutable arrays']); return done; },
    converse: async (state, text) => {
      if (text === discussed) return { reply: 'We could use an immutable array and a small pure module.', evidence: [], openQuestions: [], next: null };
      assert.ok(state.conversation.some(m => m.text === discussed));
      const answer = proposal(text); assert.ok(answer.next); answer.next.requirements = ['Local notes module with immutable arrays']; return answer;
    }, close() {} });
  c.start(); await c.talk(discussed); assert.equal(builds, 0);
  const id = c.accept(request, { role: 'builder' }); await c.talkAccepted(id); await c.idle(); assert.equal(builds, 1);
  assert.equal(c.state.inputs.find(i => i.id === id)?.role, 'builder');
  assert.equal(c.state.conversation.at(-1)?.targetRole, 'builder'); await c.close();
});
test('F-INTENT: exploratory, quoted and attributed suggestions never start implementation', async () => {
  for (const text of ['What if we changed this?', 'Maybe add a chart', '“Implement this change”', 'A colleague suggested: implement this change', 'Explore adding a chart']) {
    let builds = 0;
    const { c } = fixture({ build: async () => { builds++; return done; }, converse: async () => proposal(text), close() {} });
    c.start(); await c.talk(text); await c.idle(); assert.equal(builds, 0, text); assert.equal(c.state.slices.length, 0); await c.close();
  }
  assert.equal(authorizesImplementation('Implement this change'), true);
});
test('F-INTENT: empty decision references and missing acceptance checks cannot bypass intent validation', async () => {
  for (const missing of ['references', 'checks']) {
    const answer = proposal('Implement this change'); assert.ok(answer.next);
    if (missing === 'references') answer.next.decisionKeys = []; else delete answer.next.acceptanceChecks;
    const { c } = fixture({ build: async () => { throw new Error('Must not build'); }, converse: async () => answer, close() {} });
    await c.talk('Implement this change'); assert.equal(c.state.slices.length, 0); assert.equal(c.state.inputs[0]?.status, 'failed'); await c.close();
  }
});
test('F-INTENT/F-OWNERSHIP: coordinator metadata boundary starts real edit and check while Companion still develops prose', async () => {
  let started = false; let release: () => void = () => {};
  const { c, store } = fixture({ build: async (_slice, _signal, emit) => {
    started = true; assert.equal(c.state.ownership.owner, 'builder');
    emit({ type: 'tool_execution_start', toolName: 'write', toolCallId: 'write', args: { path: 'result.mjs' } });
    writeFileSync(join(store.workspace, 'result.mjs'), 'export const result = 42;');
    emit({ type: 'tool_execution_end', toolName: 'write', toolCallId: 'write', isError: false, result: { content: [{ type: 'text', text: 'File written' }] } });
    emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'check', args: { command: 'node --check result.mjs' } });
    execFileSync(process.execPath, ['--check', join(store.workspace, 'result.mjs')]);
    emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'check', isError: false, result: { content: [{ type: 'text', text: 'exit 0' }] } });
    return done;
  }, converse: async (state, text) => {
    const input = state.inputs.find(i => i.status === 'processing'); assert.ok(input);
    const answer = proposal(text); assert.ok(answer.next); answer.next.acceptanceChecks = ['node --check result.mjs'];
    c.proposeIntent(answer, input.id, state.intent.revision);
    assert.equal(started, true); assert.equal(c.isConversing, true);
    await new Promise<void>(resolve => { release = resolve; }); return { reply: 'Here is the reasoning.', evidence: [], openQuestions: [], next: null };
  }, close() {} });
  const talking = c.talk('Implement a module exporting 42');
  await new Promise<void>(resolve => setImmediate(resolve)); release(); await talking; await c.idle();
  assert.equal(readFileSync(join(store.workspace, 'result.mjs'), 'utf8'), 'export const result = 42;');
  assert.equal(c.state.verificationEvidence.length, 2); assert.equal(c.state.slices[0]?.status, 'completed');
  assert.equal(c.state.ownership.owner, null); await c.close();
});
test('F-OWNERSHIP/F-CONTROL: inspection continues, Escape leaves Builder running, shell transfer never overlaps', async () => {
  let building = false;
  const { c } = fixture({ build: async (_slice, signal) => { building = true; return new Promise<BuilderResult>((resolve, reject) => {
    signal.addEventListener('abort', () => { building = false; reject(new Error('Stopped')); }, { once: true });
  }); }, converse: async (_state, text) => text === 'Implement this change' ? proposal(text) : { reply: 'Inspection available', evidence: [], openQuestions: [], next: null }, close() {} });
  await c.talk('Implement this change');
  assert.equal(building, true); assert.equal(c.companionToolAllowed('read'), true);
  for (const name of ['write', 'edit', 'bash', 'unknown-mcp']) assert.equal(c.companionToolAllowed(name), false);
  await c.talk('Explain current work'); await c.interrupt(); assert.equal(building, true);
  await c.withCompanionExecution('user shell', async () => { assert.equal(building, false); assert.equal(c.state.ownership.owner, 'companion'); assert.equal(c.companionToolAllowed('bash'), false); });
  assert.equal(c.state.slices[0]?.status, 'interrupted'); assert.equal(c.state.mode, 'paused'); assert.equal(c.state.ownership.owner, null); await c.close();
});
test('F-EVIDENCE: observed failed check blocks a model claim of completed verification', async () => {
  const { c } = fixture({ build: async (_slice, _signal, emit) => {
    emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'failure', args: { command: 'node test.mjs' } });
    emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'failure', isError: true, result: { content: [{ type: 'text', text: 'exit 1' }] } }); return done;
  }, converse: async (_state, text) => proposal(text), close() {} });
  await c.talk('Implement this change'); await c.idle();
  assert.equal(c.state.slices[0]?.status, 'blocked'); assert.equal(c.state.verificationEvidence[0]?.isError, true);
  assert.deepEqual(c.state.workEvents.map(e => e.sequence), [1, 2, 3, 4]); await c.close();
});
test('F-EVIDENCE/F-CONTROL: explicit continuation resolves a failed check only after observed success of the same command', async () => {
  let attempts = 0;
  const { c } = fixture({ build: async (_slice, _signal, emit) => {
    const isError = ++attempts === 1, toolCallId = `check-${attempts}`;
    emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command: 'node test.mjs' } });
    emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId, isError, result: { content: [{ type: 'text', text: isError ? 'exit 1' : 'exit 0' }] } });
    return done;
  }, converse: async (_state, text) => proposal(text), close() {} });
  await c.talk('Implement this change'); await c.idle(); assert.equal(c.state.slices[0]?.status, 'blocked');
  c.resume(); await c.idle();
  assert.equal(c.state.slices[0]?.status, 'completed'); assert.deepEqual(c.state.verificationEvidence.map(e => e.isError), [true, false]);
  await c.close();
});
test('F-EVIDENCE: unrelated success with a reused native tool ID cannot hide a failed check', async () => {
  const { c } = fixture({ build: async (_slice, _signal, emit) => {
    for (const [toolCallId, command, isError] of [['reused-id', 'node test.mjs', true], ['reused-id', 'echo OK', false]] as const) {
      emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command } });
      emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId, isError, result: { content: [{ type: 'text', text: 'observed output' }] } });
    }
    return done;
  }, converse: async (_state, text) => proposal(text), close() {} });
  await c.talk('Implement this change'); await c.idle(); assert.equal(c.state.slices[0]?.status, 'blocked'); await c.close();
});
test('F-EVIDENCE: repair and observed rerun within one slice preserves the failed result while allowing completion', async () => {
  const { c } = fixture({ build: async (_slice, _signal, emit) => {
    for (const [toolCallId, isError] of [['initial-check', true], ['repaired-check', false]] as const) {
      emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId, args: { command: 'node --check module.mjs && node test.mjs' } });
      emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId, isError, result: { content: [{ type: 'text', text: isError ? 'Assertion failed' : 'Checks passed' }] } });
    }
    return done;
  }, converse: async (_state, text) => { const answer = proposal(text); assert.ok(answer.next); answer.next.acceptanceChecks = [{ kind: 'executable', criterion: 'Syntax and test checks', command: 'node --check module.mjs && node test.mjs' }]; return answer; }, close() {} });
  await c.talk('Implement this change'); await c.idle();
  assert.equal(c.state.slices[0]?.status, 'completed'); assert.deepEqual(c.state.verificationEvidence.map(e => e.isError), [true, false]); await c.close();
});
test('F-OWNERSHIP: failed Companion operation releases its lease and stop prohibits automatic continuation', async () => {
  const { c } = fixture({ build: async () => done, converse: async (_state, text) => proposal(text), close() {} });
  await c.pause(true); await c.talk('Implement this change'); assert.equal(c.state.slices[0]?.status, 'ready');
  await assert.rejects(c.withCompanionExecution('failing shell', async () => { throw new Error('shell failed'); }), /shell failed/);
  assert.equal(c.state.ownership.owner, null); await c.close();
});
