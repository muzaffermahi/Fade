import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { FadeApp } from '../src/app.js';
import { AcceptanceCheckSchema, ManualCheckActionSchema, CompanionSchema, V3StateSchema, validate, type Plan, type BuilderResult, type CompanionReply } from '../src/contracts.js';
import { acceptanceStatus, prepareChecks, verifiedSlice, checkDefinition } from '../src/checks.js';
import { outcomeCard, builderReport } from '../src/reports.js';
import { projectWork } from '../src/projection.js';
const done: BuilderResult = { status: 'completed', summary: 'Implementation reported done', verification: ['All checks passed — model claim'], discoveries: [] };
const executable = (command: string) => ({ kind: 'executable' as const, criterion: `Successful ${command}`, command });
function proposal(checks: NonNullable<Plan['acceptanceChecks']>, text = 'Implement this module'): CompanionReply { return { reply: 'Preparing bounded work', evidence: [{ key: 'module', text, quote: text, kind: 'decision' }], openQuestions: [], next: {
  title: 'Module', goal: text, requirements: ['Requested module'], acceptanceChecks: checks, decisionKeys: ['module'], dependencies: [], assumptions: [], ready: true,
} }; }
function fixture(checks: NonNullable<Plan['acceptanceChecks']>, build: Agents['build']) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-checks-')));
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Module'), store, { build, converse: async (_state, text) => proposal(checks, text), close() {} });
  return { c, store };
}
function observed(emit: (event: unknown) => void, command: string, id = 'check', isError = false, details?: object) {
  emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: id, args: { command } });
  emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: id, isError, result: { content: [{ type: 'text', text: isError ? 'Observed failure' : 'Observed result' }], ...(details ? { details } : {}) } });
}
test('G34/G35 F-EVIDENCE: absent, fabricated, missing, unrelated and orphan results cannot verify required criteria', async () => {
  for (const scenario of ['none', 'unrelated', 'missing', 'orphan', 'missing-isError', 'wrong-tool', 'nonzero-exit']) {
    const { c } = fixture([executable('node first.test.mjs'), executable('node second.test.mjs')], async (_slice, _signal, emit) => {
      if (scenario === 'unrelated') observed(emit, 'echo claimed success');
      if (scenario === 'missing') observed(emit, 'node first.test.mjs');
      if (scenario === 'orphan') for (const id of ['one', 'two']) emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: id, isError: false, result: { content: [{ type: 'text', text: 'Passed' }] } });
      if (scenario === 'missing-isError') { emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'one', args: { command: 'node first.test.mjs' } }); emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'one', result: { content: [{ type: 'text', text: 'Passed' }] } }); }
      if (scenario === 'wrong-tool') { emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'one', args: { command: 'node first.test.mjs' } }); emit({ type: 'tool_execution_end', toolName: 'write', toolCallId: 'one', isError: false, result: { content: [{ type: 'text', text: 'Passed' }] } }); }
      if (scenario === 'nonzero-exit') { observed(emit, 'node first.test.mjs', 'one', false, { exitCode: 1 }); observed(emit, 'node second.test.mjs', 'two'); }
      return done;
    });
    try { await c.talk('Implement this module'); await c.idle(); const slice = c.state.slices[0]; assert.ok(slice);
      assert.equal(slice.status, 'blocked', scenario); assert.equal(slice.result?.status, 'completed', 'preserve original implementation claim'); assert.equal(verifiedSlice(slice), false);
      assert.notEqual(acceptanceStatus(slice), 'passed'); assert.match(builderReport(c.state), /Acceptance:|Exact command/);
      assert.equal(c.state.inputs[0]?.status, 'processed');
    } finally { await c.close(); }
  }
});
test('G35 F-EVIDENCE: exact failure/repair retains history; duplicate ends cannot erase failure and later mutation invalidates a pass', async () => {
  for (const mutation of [false, true]) {
    const { c, store } = fixture([executable('node test.mjs')], async (_slice, _signal, emit) => {
      observed(emit, 'node test.mjs', 'same-id', true);
      // A duplicate success with no new start cannot repair that failure.
      emit({ type: 'tool_execution_end', toolName: 'bash', toolCallId: 'same-id', isError: false, result: { content: [{ type: 'text', text: 'Unpaired success' }] } });
      assert.equal(c.state.slices[0]?.checks?.[0]?.status, 'failed');
      observed(emit, 'node test.mjs', 'same-id', false);
      if (mutation) { emit({ type: 'tool_execution_start', toolName: 'edit', toolCallId: 'later-edit', args: { path: 'module.mjs' } }); emit({ type: 'tool_execution_end', toolName: 'edit', toolCallId: 'later-edit', isError: false, result: { content: [{ type: 'text', text: 'Changed after check' }] } }); }
      return done;
    });
    try { await c.talk('Implement this module'); await c.idle(); const slice = c.state.slices[0]; assert.ok(slice);
      assert.equal(slice.status, mutation ? 'blocked' : 'completed'); assert.deepEqual(slice.checks?.[0]?.history.map(attempt => attempt.status), ['failed', 'passed']);
      assert.equal(acceptanceStatus(slice), mutation ? 'not_run' : 'passed'); assert.deepEqual(store.load()?.slices[0]?.checks, slice.checks);
      if (mutation) assert.match(slice.checks?.[0]?.latestResult ?? '', /after this pass/);
    } finally { await c.close(); }
  }
});
test('G35 F-EVIDENCE: running check is visible and interruption leaves uncertain execution unverified', async () => {
  const { c } = fixture([executable('node test.mjs'), { kind: 'manual', criterion: 'Inspect after Builder quiesces' }], async (_slice, signal, emit) => {
    emit({ type: 'tool_execution_start', toolName: 'bash', toolCallId: 'held', args: { command: 'node test.mjs' } });
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Interrupted check')), { once: true }));
  });
  try { await c.talk('Implement this module'); assert.equal(c.state.slices[0]?.checks?.[0]?.status, 'running');
    assert.throws(() => c.recordManualCheck({ commandId: 'too-early', expectedRevision: c.state.revision, sliceId: c.state.slices[0]?.id, checkId: c.state.slices[0]?.checks?.[1]?.id, passed: true, evidence: 'Premature inspection' }), /quiesces/);
    await c.pause();
    const slice = c.state.slices[0]; assert.ok(slice); assert.equal(slice.status, 'interrupted'); assert.equal(acceptanceStatus(slice), 'not_run'); assert.equal(slice.checks?.[0]?.history.length, 0);
  } finally { await c.close(); }
});
test('G34/G35 F-EVIDENCE/F-CONTROL: manual acceptance needs explicit revision-checked human evidence and gates dependent automatic work', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-manual-'))); let builds = 0;
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Module'), store, { build: async (_slice, _signal, emit) => { builds++; observed(emit, 'node test.mjs'); return done; },
    converse: async (_state, text) => { const answer = proposal(builds ? [executable('node test.mjs')] : [executable('node test.mjs'), { kind: 'manual', criterion: 'Inspect the terminal contrast' }]);
      if (text !== 'Implement this module') { answer.evidence = []; assert.ok(answer.next); answer.next.title = 'Future module'; } return answer; }, close() {} });
  try {
    await c.talk('Implement this module'); await c.idle(); let first = c.state.slices[0], manual = first?.checks?.[1]; assert.ok(first && manual);
    assert.equal(first.result?.status, 'completed'); assert.equal(first.status, 'blocked'); assert.equal(acceptanceStatus(first), 'needs_human_inspection');
    c.resume(); await c.idle(); assert.equal(builds, 1, 'continue cannot approve or rerun a manual-only wait');
    await c.talk('Develop future work'); await c.idle(); const future = c.state.slices[1]; assert.ok(future); assert.deepEqual(future.plan.dependencies, [first.id]); assert.equal(builds, 1);
    first = c.state.slices[0]; manual = first?.checks?.[1]; assert.ok(first && manual);
    assert.match(projectWork(c.state).next, /held: required acceptance/);
    const action = { commandId: 'human-action', expectedRevision: c.state.revision, sliceId: first.id, checkId: manual.id, passed: true, evidence: 'Inspected light and dark terminal contrast.' };
    assert.throws(() => c.recordManualCheck({ ...action, expectedRevision: action.expectedRevision - 1 }), /Stale/);
    assert.throws(() => c.recordManualCheck({ ...action, checkId: first.checks?.[0]?.id }), /manual check/);
    assert.throws(() => c.recordManualCheck({ ...action, evidence: ' ' }), /concrete human/);
    const receipt = c.recordManualCheck(action); assert.equal(c.recordManualCheck(action), receipt); assert.throws(() => c.recordManualCheck({ ...action, passed: false }), /conflicts/);
    await c.idle(); assert.equal(builds, 2); assert.equal(verifiedSlice(first), true); assert.equal(future.status, 'completed');
    assert.equal(c.state.inputs.find(input => input.id === receipt)?.status, 'processed'); assert.equal(manual.history[0]?.source, 'human'); assert.deepEqual(store.load()?.slices[0]?.checks, first.checks);
    const card = outcomeCard(c.state, first); assert.match(card, /Implementation reported: completed/); assert.match(card, /acceptance: passed/); assert.match(card, /Reported checks:.*model claim/);
  } finally { await c.close(); }
});
test('G35 F-EVIDENCE: a failed human inspection stays failed until a separate human repair decision; claims cannot substitute', async () => {
  const { c, store } = fixture([{ kind: 'manual', criterion: 'Inspect readability' }], async () => done);
  try { await c.talk('Implement this module'); await c.idle(); const slice = c.state.slices[0], check = slice?.checks?.[0]; assert.ok(slice && check);
    c.recordManualCheck({ commandId: 'reject', expectedRevision: c.state.revision, sliceId: slice.id, checkId: check.id, passed: false, evidence: 'Focused input is clipped.' });
    assert.equal(slice.status, 'blocked'); assert.equal(acceptanceStatus(slice), 'failed');
    c.recordManualCheck({ commandId: 'accept', expectedRevision: c.state.revision, sliceId: slice.id, checkId: check.id, passed: true, evidence: 'Reinspected at 45 by 20; focused input remains reachable.' });
    assert.equal(slice.status, 'completed'); assert.deepEqual(check.history.map(attempt => attempt.status), ['failed', 'passed']);
    const fresh = new Coordinator(store.load() ?? c.state, store, { build: async () => { throw new Error('No automatic recovery replay'); }, converse: async () => { throw new Error('No automatic model approval'); }, close() {} }); fresh.recover();
    assert.equal(verifiedSlice(fresh.state.slices[0] ?? slice), true); assert.equal(fresh.state.mode, 'paused');
  } finally { await c.close(); }
});
test('G32/G34 F-CONTINUITY: v3 migration preserves original completion/claims and byte backup without inventing acceptance', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-check-migration-'))); const initial = Coordinator.initial(store.workspace, 'Project');
  const answer = proposal(['node test.mjs']); assert.ok(answer.next);
  const legacy = validate(V3StateSchema, { ...initial, version: 3,
    intent: { ...initial.intent, decisions: [{ id: 'legacy-decision', key: 'module', text: 'Implement this module', quote: 'Implement this module', sourceId: 'legacy-human', kind: 'decision', status: 'active' }] },
    conversation: [{ id: 'legacy-human', role: 'human', text: 'Implement this module', timestamp: 1, scope: 'session', sessionId: initial.currentSessionId }],
    slices: [{ id: 'legacy-completed', plan: answer.next, status: 'completed', result: done }] });
  const bytes = JSON.stringify(legacy) + '\n'; writeFileSync(join(store.directory, 'journal.jsonl'), bytes);
  const migrated = store.load(); assert.ok(migrated); const slice = migrated.slices[0]; assert.ok(slice);
  assert.equal(migrated.version, 5); assert.equal(migrated.mode, 'paused'); assert.equal(slice.status, 'completed'); assert.deepEqual(slice.result, done); assert.equal(verifiedSlice(slice), false);
  assert.equal(slice.checks?.[0]?.status, 'not_run'); assert.equal(readFileSync(join(store.directory, 'journal-v3-backup.jsonl'), 'utf8'), bytes); assert.deepEqual(store.load(), migrated);
  let builds = 0; const c = new Coordinator(migrated, store, { build: async (_slice, _signal, emit) => { builds++; observed(emit, 'node test.mjs'); return done; }, converse: async () => { throw new Error('No invented migration decision'); }, close() {} });
  try { c.recover(); assert.equal(builds, 0); c.resume(); await c.idle(); assert.equal(builds, 1); assert.equal(verifiedSlice(slice), true); }
  finally { await c.close(); }
});
test('G34 F-EVIDENCE: validated definitions distinguish legacy prose and exact commands; missing record/history stays unverified', () => {
  assert.equal(checkDefinition('Inspect colors').kind, 'manual'); assert.equal(checkDefinition('node test.mjs').kind, 'executable');
  assert.throws(() => validate(AcceptanceCheckSchema, { id: 'x', definition: { kind: 'manual', criterion: 'Inspect' }, status: 'passed', history: [] }));
  assert.throws(() => validate(ManualCheckActionSchema, { commandId: 'x', passed: true }));
  assert.throws(() => validate(CompanionSchema, { ...proposal(['node test.mjs']), acceptManual: true }));
  const answer = proposal(['node test.mjs']); assert.ok(answer.next); const checks = prepareChecks(answer.next, 0, [], () => '00000000-0000-4000-8000-000000000001'); const first = checks[0]; assert.ok(first); first.status = 'passed';
  assert.equal(acceptanceStatus({ id: 'slice', plan: answer.next, status: 'completed', result: done, checks }), 'not_run');
});
test('G35 F-CONTROL: shared human acceptance command records evidence without a provider call', async () => {
  let calls = 0; const store = new Store(mkdtempSync(join(tmpdir(), 'fade-check-command-')));
  const app = new FadeApp(store, {}, () => {}, () => {}, () => ({ build: async () => done, converse: async (_state, text) => { calls++; return proposal([{ kind: 'manual', criterion: 'Inspect UI' }], text); }, close() {} }));
  try { await app.submit('Implement this module'); await app.idle(); const slice = app.coordinator?.state.slices[0], check = slice?.checks?.[0]; assert.ok(slice && check);
    assert.match(app.inspect('builder'), /\/accept-check/); await app.command('accept-check', `${slice.id} ${check.id} pass Inspected the visible result.`); assert.equal(calls, 1); assert.equal(slice.status, 'completed');
    await assert.rejects(app.command('accept-check', 'invalid'), /Use \/accept-check/);
  } finally { await app.close(); }
});

test('G35 F-INPUT/F-CONTINUITY: failure after durable human inspection receipt cannot acknowledge acceptance or replay it on recovery', async () => {
  class FaultStore extends Store { failed = false; override save(state: Parameters<Store['save']>[0]): void { if (this.failed) throw new Error('Injected acceptance disk failure'); super.save(state); } }
  const store = new FaultStore(mkdtempSync(join(tmpdir(), 'fade-manual-fault-')));
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Project'), store, { build: async () => done, converse: async (_state, text) => proposal([{ kind: 'manual', criterion: 'Inspect result' }], text), close() {} });
  try {
    await c.talk('Implement this module'); await c.idle(); const slice = c.state.slices[0], check = slice?.checks?.[0]; assert.ok(slice && check);
    store.subscribe(() => { if (c.state.inputs.some(input => input.text.startsWith('Human inspection'))) store.failed = true; });
    let durableReceipt: string | undefined;
    assert.throws(() => c.recordManualCheck({ commandId: 'disk-fault-action', expectedRevision: c.state.revision, sliceId: slice.id, checkId: check.id, passed: true, evidence: 'Inspected the current artifact.' }, id => { durableReceipt = id; }), /disk failure/);
    const saved = store.load(); assert.ok(saved); assert.equal(saved.inputs.at(-1)?.id, durableReceipt); assert.equal(saved.inputs.at(-1)?.status, 'accepted');
    assert.equal(saved.slices[0]?.checks?.[0]?.status, 'needs_human_inspection'); assert.equal(saved.slices[0]?.checks?.[0]?.history.length, 0);
    store.failed = false; const recovered = new Coordinator(saved, store, { build: async () => { throw new Error('No replay'); }, converse: async () => { throw new Error('No model acceptance'); }, close() {} }); recovered.recover();
    assert.equal(recovered.state.inputs.at(-1)?.status, 'interrupted'); assert.equal(recovered.state.mode, 'paused'); assert.equal(verifiedSlice(recovered.state.slices[0] ?? slice), false);
  } finally { await c.close(); }
});
