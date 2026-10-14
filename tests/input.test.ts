import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { InputReceiptSchema, WorkEventSchema, OwnershipSchema, VerificationEvidenceSchema, validate, type CompanionReply } from '../src/contracts.js';

const answer: CompanionReply = { reply: 'Saved thought.', evidence: [], openQuestions: [], next: null };
const png = (label: string) => Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from(label)]).toString('base64');
function fixture(converse: Agents['converse'] = async () => answer) {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-input-')));
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore an idea'), store,
    { build: async () => { throw new Error('No build expected'); }, converse, close: () => {} });
  return { c, store };
}
test('F-INPUT: text, mode and attachments persist before transport and processing is idempotent', async () => {
  let calls = 0;
  const { c, store } = fixture(async state => { calls++; assert.equal(state.inputs[0]?.status, 'processing'); return answer; });
  const id = c.accept('same text', { mode: 'steer', attachments: [{ type: 'image', mimeType: 'image/png', data: png('first') }] });
  const second = c.accept('same text', { attachments: [{ type: 'image', mimeType: 'image/png', data: png('second') }] });
  assert.equal(store.images(store.load()?.inputs[0]?.attachments ?? [])[0]?.data, png('first'));
  assert.equal(store.images(store.load()?.inputs[1]?.attachments ?? [])[0]?.data, png('second'));
  await c.talkAccepted(id); await c.talkAccepted(id);
  assert.equal(calls, 1); assert.equal(c.state.inputs[0]?.status, 'processed');
  c.cancelInput(second); assert.equal(store.load()?.inputs[1]?.status, 'cancelled'); await c.close();
});
test('F-INPUT: failed input needs explicit retry and editing retains prior source text', async () => {
  let calls = 0;
  const { c, store } = fixture(async () => { if (++calls === 1) throw new Error('provider disconnected'); return answer; });
  const id = c.accept('Original'); await c.talkAccepted(id);
  assert.equal(c.state.inputs[0]?.status, 'failed'); await assert.rejects(c.talkAccepted(id), /explicit retry/);
  c.editInput(id, 'Revised'); c.retryInput(id); await c.talkAccepted(id);
  assert.equal(store.load()?.inputs[0]?.edits[0]?.text, 'Original');
  assert.equal(c.state.inputs[0]?.attempts, 2); assert.equal(c.state.inputs[0]?.status, 'processed'); await c.close();
});
test('F-INPUT: session navigation parks queues and rejects late responses without applying intent', async () => {
  let finish: (reply: CompanionReply) => void = () => {};
  const { c } = fixture(async () => new Promise<CompanionReply>(resolve => { finish = resolve; }));
  const first = c.accept('First'); const second = c.accept('Queued'); c.queueInput(second);
  const running = c.talkAccepted(first); const switching = c.switchSession('other-session');
  finish({ ...answer, evidence: [{ key: 'late', text: 'Late decision', quote: 'First', kind: 'decision' }] });
  await running; await switching;
  assert.equal(c.state.inputs[0]?.status, 'interrupted'); assert.equal(c.state.inputs[1]?.status, 'interrupted');
  assert.equal(c.state.intent.decisions.length, 0); assert.equal(c.state.conversation.filter(m => m.role === 'companion').length, 0);
  assert.throws(() => c.retryInput(second), /destination session/); await c.close();
});
test('F-CONTINUITY: crash recovery shows uncertain input without replaying it', async () => {
  const { c, store } = fixture(); const id = c.accept('Do not lose this'); c.queueInput(id);
  const recovered = store.load(); assert.ok(recovered);
  let calls = 0;
  const fresh = new Coordinator(recovered, store, { build: async () => { throw new Error('No build'); }, converse: async () => { calls++; return answer; }, close: () => {} });
  fresh.recover(); assert.equal(fresh.state.mode, 'paused'); assert.equal(fresh.state.inputs[0]?.status, 'interrupted');
  await assert.rejects(fresh.talkAccepted(id), /explicit retry/); assert.equal(calls, 0); await fresh.close();
});
test('F-CONTINUITY: v1 migration backs up bytes and preserves conversations, decisions, notes and slices', () => {
  const { c, store } = fixture();
  const { currentSessionId, inputs, workEvents, ownership, verificationEvidence, runLimit, ...old } = c.state;
  const legacy = { ...old, version: 1, builderMessages: [{ id: 'old-note', text: 'Question', timestamp: 1, status: 'queued' }] };
  const bytes = JSON.stringify(legacy) + '\n'; writeFileSync(join(store.directory, 'journal.jsonl'), bytes);
  const migrated = store.load(); assert.ok(migrated);
  assert.equal(migrated.version, 5); assert.equal(migrated.mode, 'paused');
  assert.deepEqual(migrated.intent, old.intent); assert.deepEqual(migrated.slices, old.slices);
  assert.deepEqual(migrated.builderMessages, legacy.builderMessages);
  assert.equal(migrated.inputs[0]?.status, 'interrupted');
  assert.equal(readFileSync(join(store.directory, 'journal-v1-backup.jsonl'), 'utf8'), bytes);
  assert.deepEqual(store.load(), migrated);
});
test('F-INPUT/F-EVIDENCE: malformed receipts and work interfaces are rejected before mutation', () => {
  const { c } = fixture(); assert.throws(() => c.accept('Text', { mode: 'steer', attachments: [{ type: 'image', mimeType: 'image/png', data: '' }] }));
  assert.equal(c.state.inputs.length, 0); assert.equal(c.state.conversation.length, 0);
  for (const schema of [InputReceiptSchema, WorkEventSchema, OwnershipSchema, VerificationEvidenceSchema]) assert.throws(() => validate(schema, {}));
});
