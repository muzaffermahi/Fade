import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync, writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator, type Agents, type Notice } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { validate, CompanionSchema, parseResponse, type BuilderResult, type CompanionReply, type Slice } from '../src/contracts.js';
import { workspacePath } from '../src/workspace.js';

const complete: BuilderResult = { status: 'completed', summary: 'Implemented', verification: ['node --check: passed'], discoveries: [] };
function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Uninitialized'); };
  let reject: (error: Error) => void = () => { throw new Error('Uninitialized'); };
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
class Fake implements Agents {
  builds: Slice[] = [];
  results: ReturnType<typeof deferred<BuilderResult>>[] = [];
  reply: CompanionReply = { reply: 'Your idea deserves room to develop.', evidence: [], openQuestions: [], next: null };
  conversationGate: ReturnType<typeof deferred<CompanionReply>> | undefined;
  reconciliationReply: CompanionReply = { reply: 'The discovery remains unresolved.', evidence: [], openQuestions: [], next: null };
  buildEvents: ((event: unknown) => void)[] = [];
  noteGate: ReturnType<typeof deferred<'queued' | 'pending'>> | undefined;
  async steerBuilder() { return this.noteGate?.promise ?? 'queued' as const; }
  async build(slice: Slice, signal: AbortSignal, emit: (event: unknown) => void) {
    this.builds.push(slice); emit('Actual fake test event');
    this.buildEvents.push(emit);
    const result = deferred<BuilderResult>(); this.results.push(result);
    signal.addEventListener('abort', () => result.reject(new Error('cancelled')), { once: true });
    return result.promise;
  }
  async converse(_state: unknown, message: string) {
    if (!message) return this.reconciliationReply;
    return this.conversationGate?.promise ?? this.reply;
  }
  close() {}
}
function setup() {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-test-'));
  const store = new Store(workspace), fake = new Fake(), notices: Notice[] = [];
  const c = new Coordinator(Coordinator.initial(workspace, 'Make a reading notebook'), store, fake, notice => notices.push(notice));
  return { c, fake, store, notices, workspace };
}
function next(c: Coordinator, decisionKeys: string[] = []): NonNullable<CompanionReply['next']> {
  const current = c.state.slices.find(s => s.status === 'running');
  return { title: 'Private notes', goal: 'Add local private notes', requirements: ['Keep notes locally'],
    decisionKeys, dependencies: current ? [current.id] : [], assumptions: ['storage'], ready: true };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('FADE-01: genuine overlap, stable active snapshot, automatic A to B handoff and provenance', async () => {
  const { c, fake, store } = setup(); c.start();
  fake.reply = { reply: 'Local notes can protect the quiet space you described.', evidence: [
    { key: 'privacy', text: 'Notes must stay local', quote: 'I definitely want local notes.', kind: 'constraint' }
  ], openQuestions: [], next: next(c, ['privacy']) };
  await c.talk('I definitely want local notes.');
  assert.equal(fake.builds.length, 1); // Conversation completed while A is still genuinely running.
  assert.equal(fake.builds[0]?.snapshot?.intent.decisions.length, 0);
  assert.equal(c.state.slices[0]?.status, 'running');
  fake.results[0]?.resolve(complete); await tick();
  assert.equal(fake.builds.length, 2);
  assert.equal(fake.builds[1]?.snapshot?.intent.decisions[0]?.key, 'privacy');
  assert.equal(fake.builds[1]?.snapshot?.requirements[0], 'Keep notes locally');
  assert.equal(c.state.slices[0]?.status, 'completed'); // Catch stale running-object race.
  fake.results[1]?.resolve(complete); await c.idle();
  const restored = store.load();
  assert.equal(restored?.slices.filter(s => s.status === 'completed').length, 2);
  assert.match(readFileSync(join(store.directory, 'intent.md'), 'utf8'), /From you: “I definitely want local notes.”/);
});
test('FADE-02: tentative thought cannot become a binding requirement', async () => {
  const { c, fake } = setup();
  fake.reply.evidence = [{ key: 'offline', text: 'Explore offline support', quote: 'I wonder if it should work offline', kind: 'constraint' }];
  await c.talk('I wonder if it should work offline');
  assert.equal(c.state.intent.decisions[0]?.kind, 'tentative');
});
test('FADE-03: fabricated quotations and malformed JSON are rejected; raw human thinking survives', async () => {
  const { c, fake } = setup();
  fake.reply.evidence = [{ key: 'offline', text: 'Offline required', quote: 'never said', kind: 'constraint' }];
  await c.talk('Maybe local data would be useful');
  assert.equal(c.state.intent.decisions.length, 0);
  assert.equal(c.state.conversation[0]?.text, 'Maybe local data would be useful');
  assert.throws(() => parseResponse(CompanionSchema, ''), SyntaxError);
  assert.throws(() => validate(CompanionSchema, { reply: '<script>' }));
});
test('FADE-04: conflicting decisions hold briefs; explicit reversal preserves history', async () => {
  const { c, fake } = setup();
  fake.reply.evidence = [{ key: 'storage', text: 'Local storage', quote: 'Use local storage', kind: 'decision' }];
  await c.talk('Use local storage');
  fake.reply.evidence = [{ key: 'storage', text: 'Remote storage', quote: 'Use remote storage', kind: 'decision' }];
  await c.talk('Use remote storage');
  assert.equal(c.state.intent.decisions.filter(d => d.status === 'conflict').length, 2);
  // No conflict-free active reference exists, so ready handoff is refused.
  fake.reply = { reply: 'Need to reconcile this.', evidence: [], openQuestions: [], next: next(c, ['storage']) };
  await c.talk('Consider the conflict');
  assert.equal(c.state.slices.length, 1);
  const fresh = setup();
  fresh.fake.reply.evidence = [{ key: 'storage', text: 'Local storage', quote: 'Use local storage', kind: 'decision' }];
  await fresh.c.talk('Use local storage');
  const previous = fresh.c.state.intent.decisions[0]; assert.ok(previous);
  fresh.fake.reply.evidence = [{ key: 'storage', text: 'File storage', quote: 'Replace that with file storage', kind: 'decision', replaces: previous.id }];
  await fresh.c.talk('Replace that with file storage');
  assert.equal(fresh.c.state.intent.decisions[0]?.status, 'superseded');
  assert.equal(fresh.c.state.history.length, 2);
});
test('FADE-05: discoveries hold affected briefs while unaffected work continues', async () => {
  const { c, fake } = setup(); c.start(); fake.reply.next = next(c);
  await c.talk('Proceed with local storage');
  fake.results[0]?.resolve({ ...complete, discoveries: [{ summary: 'Storage premise failed', affects: ['storage'] }] });
  await c.idle(); assert.equal(fake.builds.length, 1);
  assert.equal(c.state.slices[1]?.status, 'reconcile');
  const other = setup(); other.c.start(); other.fake.reply.next = next(other.c);
  await other.c.talk('Proceed');
  other.fake.results[0]?.resolve({ ...complete, discoveries: [{ summary: 'Unrelated concern', affects: ['visuals'] }] });
  await tick(); assert.equal(other.fake.builds.length, 2);
  other.fake.results[1]?.resolve(complete); await other.c.idle();
});
test('FADE-06: stale companion delta cannot overwrite an intent change during its response', async () => {
  const { c, fake } = setup(); fake.conversationGate = deferred();
  const talking = c.talk('I want a quiet place.');
  const edited = structuredClone(c.state.intent); edited.vision = 'A quiet notebook'; c.editIntent(edited);
  fake.conversationGate.resolve({ reply: 'Space matters.', evidence: [], openQuestions: ['Stale question'], next: null });
  await talking; assert.deepEqual(c.state.intent.openQuestions, []);
  assert.equal(c.state.conversation.at(-1)?.applied, false);
});
test('FADE-07: pause, cancellation, resume and model failure never masquerade as completion', async () => {
  const { c, fake } = setup(); c.start(); await c.pause();
  assert.equal(c.state.slices[0]?.status, 'interrupted');
  const interrupted = c.state.slices[0]; assert.ok(interrupted);
  fake.reply.next = { ...next(c), dependencies: [interrupted.id] }; await c.talk('Keep thinking while paused');
  assert.equal(fake.builds.length, 1);
  c.resume(); assert.equal(fake.builds.length, 2);
  fake.results[1]?.reject(new Error('API unavailable')); await c.idle();
  assert.equal(c.state.slices[0]?.status, 'blocked');
});
test('FADE-08: a cancelled obsolete future brief is never resurrected by resume', async () => {
  const { c, fake } = setup(); c.start(); fake.reply.next = next(c); await c.talk('First next slice');
  fake.reply.next = { ...next(c), title: 'Revised next slice' }; await c.talk('Revise that next slice');
  await c.pause(); c.resume();
  assert.equal(c.state.slices[1]?.status, 'cancelled');
  await c.pause();
});
test('FADE-09: bounded continuation does not spin when briefs or dependencies are incomplete', async () => {
  const { c, fake } = setup(); c.start(); fake.reply.next = { ...next(c), ready: false };
  await c.talk('Still exploring'); fake.results[0]?.resolve(complete); await c.idle();
  assert.equal(fake.builds.length, 1);
  fake.reply.next = { ...next(c), dependencies: ['invented'] }; await c.talk('Bad reference');
  assert.equal(c.state.slices.length, 2);
});
test('FADE-10: persistence, crash recovery, partial journal append, editing and process lock', async () => {
  const { c, store, workspace } = setup(); store.lock(); assert.throws(() => new Store(workspace).lock(), /already open/);
  const running = c.state.slices[0]; assert.ok(running); running.status = 'running'; store.save(c.state);
  appendFileSync(join(store.directory, 'journal.jsonl'), '{"broken":');
  const recovered = store.load(); assert.ok(recovered);
  const fresh = new Coordinator(recovered, store, new Fake()); fresh.recover();
  assert.equal(recovered.mode, 'paused'); assert.equal(recovered.slices[0]?.status, 'interrupted');
  const editPath = store.prepareIntentEdit(recovered);
  const edit = structuredClone(recovered.intent); edit.vision = 'Human edited vision'; writeFileSync(editPath, JSON.stringify(edit));
  store.save(recovered); // Background writes must not clobber an in-progress human edit.
  fresh.editIntent(store.readIntent()); assert.equal(recovered.intent.vision, 'Human edited vision');
  assert.throws(() => fresh.editIntent(edit), /Stale/); store.close();
});
test('FADE-11: canonical paths reject traversal, protected state and symlink escape', async () => {
  const { workspace } = setup(); const outside = mkdtempSync(join(tmpdir(), 'fade-outside-'));
  await assert.rejects(workspacePath(workspace, '../escaped.txt'));
  await assert.rejects(workspacePath(workspace, '.fade/state.json'));
  mkdirSync(join(workspace, 'src'));
  assert.equal(await workspacePath(workspace, 'src/new.ts'), join(workspace, 'src/new.ts'));
  symlinkSync(outside, join(workspace, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(workspacePath(workspace, 'link/new.txt'));
});
test('FADE-13: discovery reconciliation preserves authorship and can continue without new human input', async () => {
  const { c, fake } = setup(); c.start(); fake.reply.next = next(c); await c.talk('I want local notes');
  fake.reconciliationReply = { reply: 'The storage premise changed, but the local intent still works with files.',
    evidence: [], openQuestions: [], next: { ...next(c), assumptions: ['file-storage'] } };
  fake.results[0]?.resolve({ ...complete, discoveries: [{ summary: 'Use files instead of old storage', affects: ['storage'] }] });
  await tick(); await tick(); assert.equal(fake.builds.length, 2);
  assert.equal(c.state.conversation.filter(m => m.role === 'human').length, 1);
  assert.equal(c.state.intent.decisions.length, 0);
  fake.results[1]?.resolve(complete); await c.idle();
});
test('FADE-14: the automatic slice limit prevents an uncontrolled execution loop', async () => {
  const { c, fake } = setup(); c.start();
  for (let i = 0; i < 4; i++) {
    fake.reply.next = { ...next(c), title: `Next ${i}` }; await c.talk(`Develop slice ${i}`);
    fake.results[i]?.resolve(complete); await tick();
  }
  await c.idle(); assert.equal(fake.builds.length, 4);
  assert.equal(c.state.remainingSlices, 0);
  assert.equal(c.state.slices.at(-1)?.status, 'ready');
  c.resume(); assert.equal(fake.builds.length, 5); await c.pause();
});

test('FADE-22: Builder notes are durable, queued is distinct from received, and snapshots remain fixed', async () => {
  const { c, fake, store } = setup(); c.start();
  const before = structuredClone(c.state.slices[0]?.snapshot);
  const note = await c.messageBuilder('Explain which checks you ran.');
  assert.equal(note.status, 'queued');
  assert.equal(store.load()?.builderMessages?.[0]?.text, note.text);
  fake.buildEvents[0]?.({ type: 'builder_note_received', id: note.id });
  assert.equal(c.state.builderMessages?.[0]?.status, 'received');
  assert.deepEqual(c.state.slices[0]?.snapshot, before);
  await c.close();
});

test('FADE-23: notes survive concurrent intent replacement and undelivered queues recover for the next turn', async () => {
  const { c, fake, store } = setup(); c.start(); fake.noteGate = deferred<'queued' | 'pending'>();
  const sending = c.messageBuilder('Report your current limitation.');
  await c.talk('Keep the work local.'); // Replaces the state, including a cloned mailbox.
  const note = c.state.builderMessages?.[0]; assert.ok(note);
  fake.buildEvents[0]?.({ type: 'builder_note_received', id: note.id });
  fake.noteGate.resolve('queued'); await sending;
  assert.equal(c.state.builderMessages?.[0]?.status, 'received');
  fake.noteGate = undefined;
  const undelivered = await c.messageBuilder('A question saved before interruption.');
  assert.equal(undelivered.status, 'queued'); await c.pause();
  assert.equal(c.state.builderMessages?.[1]?.status, 'pending');
  const recovered = new Coordinator(store.load() ?? c.state, store, fake); recovered.recover();
  assert.equal(recovered.state.builderMessages?.[0]?.status, 'received');
  assert.equal(recovered.state.builderMessages?.[1]?.status, 'pending');
  await recovered.close(); await c.close();
});

test('FADE-25: a late queue response cannot strand a note on a finished Builder, and invalid notes never mutate the mailbox', async () => {
  const { c, fake } = setup(); c.start(); fake.noteGate = deferred<'queued' | 'pending'>();
  const sending = c.messageBuilder('Retain this question if the current turn finishes.');
  fake.results[0]?.resolve(complete); await c.idle();
  fake.noteGate.resolve('queued'); const saved = await sending;
  assert.equal(saved.status, 'pending'); assert.equal(saved.sliceId, undefined);
  const count = c.state.builderMessages?.length;
  await assert.rejects(c.messageBuilder('x'.repeat(20001)), /Invalid data/);
  assert.equal(c.state.builderMessages?.length, count);
  await c.close();
});

test('FADE-26: late Builder transport cannot write state after the workspace is closed', async () => {
  const { c, fake, store } = setup(); c.start(); fake.noteGate = deferred<'queued' | 'pending'>();
  const sending = c.messageBuilder('Keep this question through shutdown.');
  await c.close(); const journal = readFileSync(join(store.directory, 'journal.jsonl'), 'utf8');
  fake.noteGate.resolve('queued'); const saved = await sending;
  assert.equal(saved.status, 'pending');
  assert.equal(readFileSync(join(store.directory, 'journal.jsonl'), 'utf8'), journal);
});
