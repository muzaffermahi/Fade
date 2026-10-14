import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { FadeApp } from '../src/app.js';
import { Coordinator } from '../src/coordinator.js';
import { InspectionView } from '../src/inspection.js';
import { captureWorkspace, renderChanges } from '../src/changes.js';
import { builderReport, executionLog, observedOutput } from '../src/reports.js';
test('F-VIEWS/F-EVIDENCE: Builder inspection exposes frozen requirements, human sources and readable streaming results', () => {
  const state = Coordinator.initial('fixture', 'Implement storage');
  const decision = { id: randomUUID(), key: 'storage', text: 'Use local files', quote: 'Use local files', sourceId: 'human-fixture', kind: 'decision' as const, status: 'active' as const };
  state.intent.decisions.push(decision);
  state.slices.push({ id: 'slice-fixture', status: 'running', plan: { title: 'Storage', goal: 'Store notes', requirements: ['Write notes'], decisionKeys: ['storage'], dependencies: [], assumptions: ['UTF-8'], acceptanceChecks: ['Read a saved note'], ready: true },
    snapshot: { intent: structuredClone(state.intent), requirements: ['Frozen requirement'], goal: 'Frozen goal' } });
  state.intent.decisions[0] = { ...decision, text: 'Changed future' };
  const brief = builderReport(state);
  assert.match(brief, /Frozen goal/); assert.match(brief, /Frozen requirement/); assert.match(brief, /Read a saved note/);
  assert.match(brief, /human-fixture: Use local files/); assert.doesNotMatch(brief, /Changed future/);
  const event = { type: 'tool_execution_update', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'Checking Unicode 笔记' }] } };
  const log = executionLog(JSON.stringify({ event: { event } }));
  assert.match(log, /streaming/); assert.match(log, /Checking Unicode 笔记/); assert.doesNotMatch(log, /partialResult/);
  assert.match(observedOutput({ content: [{ type: 'text', text: 'x'.repeat(2000) }] }), /truncated/);
});
test('F-EVIDENCE: omitted large files are never reported as confirmed deletions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fade-omission-'));
  writeFileSync(join(root, 'growing.txt'), 'small'); const before = await captureWorkspace(root);
  writeFileSync(join(root, 'growing.txt'), 'x'.repeat(70000));
  const diff = renderChanges(before, await captureWorkspace(root));
  assert.match(diff, /Creation\/deletion is unknown/); assert.doesNotMatch(diff, /\+\+\+ \/dev\/null/);
});
test('F-VIEWS: inspection queries do not mutate state, transcript or model context', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-inspect-')));
  const app = new FadeApp(store, {}, () => {}, () => {}, () => ({ build: async () => { throw new Error('No build'); }, converse: async () => ({ reply: 'Explore', evidence: [], openQuestions: [], next: null }), close() {} }));
  await app.submit('What if we changed this?'); const before = JSON.stringify(app.coordinator?.state);
  for (const name of ['builder', 'intent', 'changes', 'status', 'reports', 'inputs', 'log', 'help']) assert.ok(await app.inspectAsync(name));
  assert.equal(JSON.stringify(app.coordinator?.state), before); await app.close();
});
test('F-VIEWS: overlay supports search, paging, Escape and an explicit intent editing action', () => {
  const actions: string[] = []; const view = new InspectionView('Intent', () => Array.from({ length: 40 }, (_, n) => `Decision ${n}`).join('\n'), action => actions.push(action), true);
  view.handleInput('\x1b[6~'); assert.match(view.render(80).join('\n'), /2\/4/);
  view.handleInput('3'); assert.match(view.render(80).join('\n'), /Decision 3/); assert.doesNotMatch(view.render(80).join('\n'), /Decision 20/);
  view.handleInput('\x05'); view.handleInput('\x1b'); assert.deepEqual(actions, ['edit', 'close']);
});
test('F-EVIDENCE: actual before/after workspace diff preserves external changes and rejects state traversal', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fade-changes-')); const store = new Store(root), id = randomUUID();
  writeFileSync(join(root, 'file.md'), 'before\n'); await store.beginChanges(id);
  writeFileSync(join(root, 'file.md'), 'after\n'); writeFileSync(join(root, 'external.md'), 'External edit');
  await store.finishChanges(id); const diff = store.readChanges(id);
  assert.match(diff, /-before/); assert.match(diff, /\+after/); assert.match(diff, /External edit/); assert.match(diff, /Attribution is uncertain/);
  assert.equal(readFileSync(join(root, 'external.md'), 'utf8'), 'External edit'); assert.throws(() => store.readChanges('../escape'));
});
test('F-VIEWS/F-CONTINUITY: intent conflict resolution records human provenance and preserves existing active brief', () => {
  const root = mkdtempSync(join(tmpdir(), 'fade-intent-')); const store = new Store(root);
  const c = new Coordinator(Coordinator.initial(root, 'Build notes'), store, { build: async () => { throw new Error('No build'); }, converse: async () => ({ reply: 'Explore', evidence: [], openQuestions: [], next: null }), close() {} });
  const sourceId = c.accept('Use local storage');
  c.state.intent.decisions.push({ id: randomUUID(), key: 'storage', text: 'Use local storage', quote: 'Use local storage', sourceId, kind: 'decision', status: 'conflict' });
  const edit = structuredClone(c.state.intent); const decision = edit.decisions[0]; assert.ok(decision); decision.status = 'active';
  c.editIntent(edit); const saved = c.state.intent.decisions[0]; assert.ok(saved);
  assert.notEqual(saved.sourceId, sourceId); assert.ok(c.state.conversation.some(m => m.id === saved.sourceId && m.role === 'human'));
  assert.equal(c.state.inputs.at(-1)?.status, 'processed'); assert.equal(c.state.history.at(-1)?.reason, 'Human edited intent');
});
test('F-VIEWS: execution history search reaches old records while paging remains bounded', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-log-')));
  for (let n = 0; n < 120; n++) store.event({ sliceId: 'fixture', event: { type: 'tool_execution_end', toolName: 'bash', isError: n === 0,
    result: { content: [{ type: 'text', text: n === 0 ? 'old unique failure' : `event ${n}` }] } } });
  assert.match(await store.readLogPage('old unique'), /old unique failure/);
  assert.match(await store.readLogPage('', 1), /event 40/); assert.doesNotMatch(await store.readLogPage('', 1), /event 119/);
  await assert.rejects(store.readLogPage('', 11), /between 0 and 10/);
});
