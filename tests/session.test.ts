import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { FadeApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { ConversationSchema, LegacyStateSchema, V2StateSchema, validate, type CompanionReply } from '../src/contracts.js';
import { sharedContext } from '../src/shared-context.js';

const answer: CompanionReply = { reply: 'Observed reply', evidence: [], openQuestions: [], next: null };
const idleAgents: Agents = { build: async () => { throw new Error('No build expected'); }, converse: async () => answer, close() {} };
function legacyFixture() {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-session-')));
  const state = Coordinator.initial(store.workspace, 'Shared project intent');
  const receipt = { id: 'human-known', sessionId: 'native-old', role: 'companion', mode: 'steer', text: 'Private old thought',
    attachments: [{ type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' }], status: 'processing', timestamp: 10, updatedAt: 11, attempts: 1, edits: [] };
  const old = validate(V2StateSchema, { ...state, version: 2, currentSessionId: 'native-old', inputs: [receipt],
    conversation: [{ id: receipt.id, role: 'human', text: receipt.text, timestamp: 10, targetRole: 'companion' },
      { id: 'assistant-old', role: 'companion', text: 'Unproven old suggestion', timestamp: 11, applied: true, targetRole: 'companion' },
      { id: 'human-unproven', role: 'human', text: 'Unproven human thought', timestamp: 12 }],
    builderMessages: [{ id: 'note-old', text: 'Shared implementation note', timestamp: 8, status: 'pending' }],
    discoveries: [{ summary: 'Observed shared fact', affects: ['future'] }] });
  return { store, old };
}

test('G31/G32 F-CONTINUITY: v2 migration preserves bytes before torn-tail repair and labels unproven history', () => {
  const { store, old } = legacyFixture();
  const journal = JSON.stringify(old) + '\n{"torn":'; const checkpoint = JSON.stringify(old, null, 2);
  writeFileSync(join(store.directory, 'journal.jsonl'), journal); writeFileSync(join(store.directory, 'checkpoint.json'), checkpoint);
  const migrated = store.load(); assert.ok(migrated);
  assert.equal(migrated.version, 5); assert.equal(migrated.mode, 'paused'); assert.equal(migrated.revision, old.revision + 1);
  assert.equal(readFileSync(join(store.directory, 'journal-v2-backup.jsonl'), 'utf8'), journal);
  assert.equal(readFileSync(join(store.directory, 'checkpoint-v2-backup.json'), 'utf8'), checkpoint);
  assert.equal(migrated.conversation.length, old.conversation.length);
  old.conversation.forEach((record, index) => { const preserved = migrated.conversation[index]; assert.ok(preserved); for (const [key, value] of Object.entries(record)) assert.deepEqual(Reflect.get(preserved, key), value); });
  const human = migrated.conversation[0]; assert.ok(human?.scope === 'session'); assert.equal(human.sessionId, 'native-old'); assert.equal(human.receiptId, 'human-known');
  assert.ok(migrated.conversation.slice(1).every(record => record.scope === 'project_history' && record.historyReason.length > 0));
  assert.equal(migrated.inputs[0]?.status, 'interrupted'); assert.deepEqual(store.images(migrated.inputs[0]?.attachments ?? []), old.inputs[0]?.attachments);
  for (const key of ['intent', 'builderMessages', 'discoveries', 'workEvents', 'verificationEvidence', 'history', 'sessions'] as const) assert.deepEqual(migrated[key], old[key]);
  assert.deepEqual(store.load(), migrated); assert.equal(readdirSync(store.directory).filter(name => name.startsWith('journal-v2-backup')).length, 1);
});

test('G32 F-CONTINUITY: checkpoint-only v1 migration never treats synthesized receipts as native session proof', () => {
  const { store, old } = legacyFixture();
  const { currentSessionId, inputs, workEvents, ownership, verificationEvidence, usage, runLimit, ...fields } = old;
  const legacy = validate(LegacyStateSchema, { ...fields, version: 1, conversation: old.conversation.map(({ targetRole, ...record }) => record) });
  const bytes = JSON.stringify(legacy); writeFileSync(join(store.directory, 'checkpoint.json'), bytes);
  const migrated = store.load(); assert.ok(migrated);
  assert.equal(readFileSync(join(store.directory, 'checkpoint-v1-backup.json'), 'utf8'), bytes);
  assert.equal(migrated.conversation.length, legacy.conversation.length); assert.ok(migrated.conversation.every(record => record.scope === 'project_history'));
  assert.ok(migrated.inputs.every(input => input.status === 'interrupted')); assert.equal(migrated.mode, 'paused');
  assert.deepEqual(sharedContext(migrated, 'companion').discussion, []);
});

test('G32 F-CONTINUITY: failed migration save retains source and backup; explicit restart migrates once', () => {
  const { store, old } = legacyFixture(); const bytes = JSON.stringify(old) + '\n'; writeFileSync(join(store.directory, 'journal.jsonl'), bytes);
  const original = store.save; store.save = () => { throw new Error('Injected migration write failure'); };
  assert.throws(() => store.load(), /Injected migration write failure/);
  assert.equal(readFileSync(join(store.directory, 'journal.jsonl'), 'utf8'), bytes); assert.equal(readFileSync(join(store.directory, 'journal-v2-backup.jsonl'), 'utf8'), bytes);
  store.save = original; const migrated = store.load(); assert.ok(migrated); assert.equal(migrated.conversation.length, old.conversation.length); assert.deepEqual(store.load(), migrated);
  assert.equal(readFileSync(join(store.directory, 'journal-v2-backup.jsonl'), 'utf8'), bytes);
});

test('G32 F-CONTINUITY: unknown versions, mismatched projects and moved workspaces fail without overwriting provenance', () => {
  for (const failure of ['version', 'project', 'workspace']) {
    const { store, old } = legacyFixture(); const journal = JSON.stringify(failure === 'version' ? { ...old, version: 99 } : failure === 'workspace' ? { ...old, workspace: join(store.workspace, 'elsewhere') } : old) + '\n';
    writeFileSync(join(store.directory, 'journal.jsonl'), journal);
    if (failure === 'project') writeFileSync(join(store.directory, 'checkpoint.json'), JSON.stringify({ ...old, id: 'other-project' }));
    assert.throws(() => store.load()); assert.equal(readFileSync(join(store.directory, 'journal.jsonl'), 'utf8'), journal);
    assert.equal(readdirSync(store.directory).some(name => name.includes('backup')), false);
  }
  assert.throws(() => validate(ConversationSchema, { id: 'x', role: 'human', text: 'x', timestamp: 0, scope: 'session' }));
  assert.throws(() => validate(ConversationSchema, { id: 'x', role: 'human', text: 'x', timestamp: 0, scope: 'project_history' }));
});

test('G31/G32 F-INPUT: selected session alone reaches providers; labelled shared intent and archived history survive resume', async () => {
  const { store, old } = legacyFixture(); const receipt = old.inputs[0]; assert.ok(receipt); receipt.status = 'processed';
  old.intent.decisions.push({ id: 'settled', key: 'quiet', text: 'Shared quiet design', quote: receipt.text, kind: 'decision', sourceId: receipt.id, status: 'active' });
  writeFileSync(join(store.directory, 'journal.jsonl'), JSON.stringify(old) + '\n');
  const app = new FadeApp(store, {}, () => {}, () => {}, () => ({ ...idleAgents, converse: async state => {
    assert.equal(state.currentSessionId, 'native-new'); assert.equal(state.conversation.some(record => record.text.includes('old')), false);
    const context = sharedContext(state, 'companion'); assert.equal(context.discussion.some(record => record.text.includes('old')), false);
    assert.equal(context.settledHumanIntent[0]?.text, 'Shared quiet design'); return answer;
  } }));
  try {
    await app.setSession('native-new'); assert.deepEqual(app.history(), []); assert.match(app.inspect('history'), /Project history.*\ncompanion\nUnproven old suggestion/);
    await app.submit('New session thought'); await app.idle(); assert.equal(app.history().length, 2);
    app.report('provider_failure', 'companion', 'late', 'Old destination failure', ['inputs'], 'human-known');
    assert.equal(app.notifications.visible('companion', app.currentSessionId, app.coordinator?.state).some(item => item.operationId === 'late'), false);
    await app.setSession('native-old'); assert.deepEqual(app.history().map(record => record.text), ['Private old thought']);
    assert.equal(app.coordinator?.state.intent.decisions[0]?.text, 'Shared quiet design');
  } finally { await app.close(); }
});

test('G33 F-INPUT: late native reply observations cannot cross sessions or authorize intent', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-session-late-')));
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Project'), store, { ...idleAgents, converse: async (state, _text, _signal, emit, sourceId) => {
    emit?.({ type: 'fade_reply_observed', id: 'late', sessionId: 'wrong-session', receiptId: sourceId, text: 'Wrong destination', timestamp: 1 });
    emit?.({ type: 'fade_reply_observed', id: 'unknown', sessionId: state.currentSessionId, receiptId: 'unknown-receipt', text: 'Unknown source', timestamp: 1 });
    return answer;
  } });
  try { await c.talkAccepted(c.accept('Current thought')); assert.equal(c.state.conversation.some(record => record.id === 'late' || record.id === 'unknown'), false); assert.equal(c.state.intent.decisions.length, 0); }
  finally { await c.close(); }
});
