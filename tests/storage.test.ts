import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.js';
import { imageMime, imageBytes, validateImages, validateSendText, textCharacters, IMAGE_LIMITS, emptyArchives, indexDelta, applyIndexDelta } from '../src/payloads.js';
import type { TerminalState } from '../src/contracts.js';
import { V4StateSchema, StoredIndexSchema, validate } from '../src/contracts.js';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { PiAgents } from '../src/pi.js';

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const image = { type: 'image' as const, mimeType: 'image/png', data: PNG.toString('base64') };
const root = () => mkdtempSync(join(tmpdir(), 'fade-storage-'));
const draft: TerminalState = { sessionId: 'fixture', mode: 'fade', focus: 'builder', builderDraft: 'Draft', companionDraft: '',
  builderAttachments: [image], companionAttachments: [], builderScroll: 0, companionScroll: 0 };

test('G37/G39 F21: repeated decisions, Builder session paths and receipt edits stay bounded with cold restart provenance', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Metadata history');
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents), id = c.accept('Original editable draft');
  for (let n = 0; n < 40; n++) c.editInput(id, `Edit ${n}`);
  state.sessions.builders = Array.from({ length: 100 }, (_value, n) => `Original Pi session ${n}`);
  state.intent.decisions = Array.from({ length: 300 }, (_value, n) => ({ id: `decision-${n}`, key: 'same-key', text: `Original decision ${n}`,
    quote: `Original decision ${n}`, sourceId: id, kind: 'decision' as const, status: n === 299 ? 'active' as const : 'superseded' as const }));
  store.save(state);
  assert.equal(state.inputs[0]?.edits.length, 16); assert.equal(state.inputs[0]?.text, 'Edit 39');
  assert.equal(state.intent.decisions.length, 33); assert.equal(state.intent.decisions.at(-1)?.status, 'active'); assert.equal(state.sessions.builders.length, 32);
  assert.match(store.readMetadataPage('Original editable draft'), /Original editable draft/);
  assert.match(store.readMetadataPage('Original decision 0'), /decision-0/);
  assert.match(store.readMetadataPage('Original Pi session 0'), /Original Pi session 0/);
  assert.equal(store.readMetadataPage('', 0).split('\n\n').length, 41);
  await c.close();
  const restarted = new Store(store.workspace), recovered = restarted.load(); assert.ok(recovered);
  assert.deepEqual(recovered.metadataHead, state.metadataHead); assert.equal(recovered.intent.decisions.length, 33);
  assert.match(restarted.readMetadataPage('Edit 0'), /Edit 0/); assert.equal(recovered.sessions.builders.length, 32);
  const head = recovered.metadataHead; assert.ok(head); writeFileSync(join(store.directory, 'payloads', `${head.sha256}.blob`), 'Corrupt metadata');
  assert.throws(() => restarted.readMetadataPage(), /hash\/size/); restarted.close();
});

test('G35/G37 F21: legacy shell evidence receives exact command identity so a later matching repair unpins it', () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Old failure');
  state.slices.push({ id: 'slice', status: 'blocked', plan: { title: 'Repair', goal: 'Repair', requirements: [], decisionKeys: [], dependencies: [], assumptions: [], ready: false } });
  const failed = { sliceId: 'slice', sequence: 1, operationId: 'old', toolName: 'bash', timestamp: 1, isError: true,
    input: { args: { command: ' node same.test.mjs ' } }, result: { content: [{ type: 'text', text: 'Old failure' }] } };
  state.verificationEvidence.push(failed); store.save(state);
  const hash = createHash('sha256').update('node same.test.mjs', 'utf8').digest('hex'); assert.equal(state.verificationEvidence[0]?.commandHash, hash);
  state.verificationEvidence.push({ ...failed, sequence: 2, operationId: 'repair', isError: false, commandHash: hash });
  for (let n = 3; n <= 140; n++) state.verificationEvidence.push({ ...failed, sequence: n, operationId: `read-${n}`, toolName: 'read', isError: false });
  store.save(state); assert.equal(state.verificationEvidence.length, 128);
  assert.equal(state.verificationEvidence.some(evidence => evidence.sequence === 1), false); assert.equal(state.archives?.verificationEvidence.count, 12); store.close();
});

test('G15/G42 F21: an invalid initial Builder image bundle fails before changes or Pi sessions are opened', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Invalid Builder image');
  const c = new Coordinator(state, store, { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} });
  const id = c.accept('Valid receipt', { role: 'builder', attachments: [image] });
  const input = state.inputs.find(receipt => receipt.id === id); assert.ok(input); input.attachments = [{ ...image, data: Buffer.from('GIF89a').toString('base64') }];
  const slice = { id: 'slice', status: 'ready' as const, plan: { title: 'Build', goal: 'Build', requirements: [], decisionKeys: [], dependencies: [], assumptions: [], ready: true } };
  state.builderMessages = [{ id, sliceId: slice.id, text: 'Valid receipt', status: 'pending', timestamp: 1 }];
  let changes = 0; mock.method(store, 'beginChanges', async () => { changes++; });
  const pi = new PiAgents(store, state);
  try { await assert.rejects(pi.build(slice, new AbortController().signal, () => {}), /signature/); assert.equal(changes, 0); assert.equal(state.sessions.builders.length, 0); }
  finally { mock.restoreAll(); pi.close(); input.attachments = store.referenceImages([image]); await c.close(); }
});

test('G15/G16 F21: signature/MIME/base64/count/decoded-size boundaries and Unicode send length are explicit', () => {
  assert.equal(imageMime(PNG), 'image/png'); assert.equal(imageMime(Buffer.from([255, 216, 255, 224])), 'image/jpeg');
  const webp = Buffer.from('RIFF0000WEBPVP8X', 'ascii'); assert.equal(imageMime(webp), 'image/webp');
  for (const bytes of [Buffer.from('GIF89a'), Buffer.from('WEBP'), PNG.subarray(0, 4), Buffer.from('RIFF0000WEBPWHAT')]) assert.throws(() => imageMime(bytes), /signature/);
  assert.equal(validateImages(Array.from({ length: 20 }, () => image)).length, 20);
  assert.throws(() => validateImages(Array.from({ length: 21 }, () => image)));
  assert.throws(() => validateImages([{ ...image, mimeType: 'image/jpeg' }]), /MIME/);
  assert.throws(() => validateImages([{ ...image, data: image.data + '!' }]), /base64/);
  const maximum = Buffer.alloc(IMAGE_LIMITS.each); PNG.copy(maximum);
  const largest = { ...image, data: maximum.toString('base64') };
  assert.equal(imageBytes(largest.data), IMAGE_LIMITS.each); assert.equal(validateImages([largest, largest]).length, 2);
  assert.throws(() => validateImages([largest, largest, image]), /30 MiB/);
  const oversized = Buffer.alloc(IMAGE_LIMITS.each + 1); PNG.copy(oversized);
  assert.throws(() => validateImages([{ ...image, data: oversized.toString('base64') }]));
  validateSendText('a'.repeat(20000)); validateSendText('😀'.repeat(20000)); assert.equal(textCharacters('a😀中'), 3);
  assert.throws(() => validateSendText('😀'.repeat(20001)), /20,000.*draft is retained/);
});

test('G38 F21/F-CONTINUITY: continuous typing coalesces metadata on a fixed 150ms deadline and close flushes', () => {
  class CountingStore extends Store {
    readonly saved: TerminalState[] = [];
    override saveTerminal(state: TerminalState): void { this.saved.push(state); super.saveTerminal(state); }
  }
  const store = new CountingStore(root()); mock.timers.enable({ apis: ['setTimeout'] });
  try {
    for (let n = 0; n < 40; n++) store.queueTerminal({ ...draft, builderDraft: `Edit ${n}` });
    mock.timers.tick(149); assert.equal(store.saved.length, 0); assert.equal(store.loadTerminal('fixture'), undefined);
    store.queueTerminal({ ...draft, builderDraft: 'Last edit at 149ms' }); mock.timers.tick(1);
    assert.equal(store.saved.length, 1); assert.equal(store.loadTerminal('fixture')?.builderDraft, 'Last edit at 149ms');
    const mutable = { ...draft, builderAttachments: [{ ...image }] }; store.queueTerminal(mutable); mutable.builderDraft = 'Later mutation';
    const mutableImage = mutable.builderAttachments[0]; assert.ok(mutableImage); mutableImage.data = 'Changed outside draft snapshot'; store.close();
    assert.equal(store.saved.length, 2); assert.equal(store.loadTerminal('fixture')?.builderDraft, 'Draft');
    assert.equal(store.images(store.loadTerminal('fixture')?.builderAttachments ?? [])[0]?.data, image.data); mock.timers.tick(200);
    assert.equal(store.saved.length, 2, 'no delayed write after close');
  } finally { store.close(); mock.timers.reset(); }
});

test('G38/G42 F21: failed best-effort draft persistence is visible, preserves prior bytes and can explicitly save after repair', () => {
  class DraftFault extends Store {
    fail = false;
    override saveTerminal(state: TerminalState): void { if (this.fail) throw new Error('Draft ENOSPC'); super.saveTerminal(state); }
  }
  const store = new DraftFault(root()); store.saveTerminal(draft); store.fail = true;
  const errors: string[] = []; const editable = { ...draft, builderDraft: 'Retained unsaved draft' };
  store.queueTerminal(editable, error => { errors.push(String(error)); throw new Error('Observer failed'); });
  store.queueTerminal({ ...draft, sessionId: 'other' }, error => errors.push(String(error))); store.flushTerminal();
  assert.equal(errors.length, 2); assert.equal(editable.builderDraft, 'Retained unsaved draft');
  assert.equal(store.loadTerminal('fixture')?.builderDraft, 'Draft'); assert.equal(store.loadTerminal('other'), undefined);
  store.fail = false; store.queueTerminal(editable); store.flushTerminal('fixture');
  assert.equal(store.loadTerminal('fixture')?.builderDraft, editable.builderDraft); store.close();
});

test('G37/G38 F21 payload records: deduplication, exact legacy JSON bytes, checksum and protected path checks', () => {
  const store = new Store(root()); const original = JSON.stringify({ data: 'not-new-base64\ud800', text: '旧的 exact bytes 😀', raw: 'x'.repeat(200000) });
  const ref = store.putPayload(original, 'json'); const repeated = store.putPayload(original, 'json'); assert.deepEqual(repeated, ref);
  assert.equal(readdirSync(join(store.directory, 'payloads')).length, 1); assert.equal(store.readPayload(ref), original);
  assert.deepEqual(JSON.parse(store.readPayload(ref)), JSON.parse(original));
  assert.throws(() => store.readPayload({ ...ref, sha256: '../outside' }), /Invalid data/);
  assert.throws(() => store.readPayload({ ...ref, bytes: ref.bytes + 1 }), /hash\/size/);
  const path = join(store.directory, 'payloads', `${ref.sha256}.blob`); writeFileSync(path, 'tampered');
  assert.throws(() => store.readPayload(ref), /hash\/size/); assert.throws(() => store.putPayload(original, 'json'), /hash\/size/);
  const outside = join(root(), 'outside'); writeFileSync(outside, 'OUTSIDE');
  const second = store.putPayload('independent', 'utf8'); linkSync(join(store.directory, 'payloads', `${second.sha256}.blob`), outside + '-link');
  assert.throws(() => store.readPayload(second), /Linked|protected/); assert.equal(readFileSync(outside, 'utf8'), 'OUTSIDE');
});

test('F21 F-CONTINUITY: v4 image migration retains unsupported legacy bytes, exact backup and explicit human check history', () => {
  const store = new Store(root()), initial = Coordinator.initial(store.workspace, 'Legacy intent');
  const legacyData = 'not-new-base64\ud800';
  const old = validate(V4StateSchema, { ...initial, version: 4, inputs: [{ id: 'human-acceptance', sessionId: initial.id, role: 'builder', mode: 'steer', text: 'Human checked',
    attachments: [{ type: 'image', mimeType: 'image/gif', data: legacyData }], status: 'processed', timestamp: 1, updatedAt: 1, attempts: 1, edits: [] }],
    slices: [{ id: 'old-slice', status: 'completed', plan: { title: 'Old work', goal: 'Keep it', requirements: ['Human inspection'], decisionKeys: [], dependencies: [], assumptions: [], ready: false,
      acceptanceChecks: [{ kind: 'manual', criterion: 'Human inspection' }] }, result: { status: 'completed', summary: 'Existing claim', verification: ['Existing claim'], discoveries: [] },
      checks: [{ id: 'old-check', definition: { kind: 'manual', criterion: 'Human inspection' }, status: 'passed', afterSequence: 0, latestResult: 'Human proof',
        history: [{ source: 'human', commandId: 'original-action', receiptId: 'human-acceptance', timestamp: 1, status: 'passed', evidence: 'Human proof' }] }] }] });
  const bytes = JSON.stringify(old) + '\n'; writeFileSync(join(store.directory, 'journal.jsonl'), bytes);
  const migrated = store.load(); assert.ok(migrated); assert.equal(migrated.version, 5); assert.equal(migrated.mode, 'paused');
  assert.equal(readFileSync(join(store.directory, 'journal-v4-backup.jsonl'), 'utf8'), bytes);
  assert.deepEqual(migrated.slices[0]?.checks, old.slices[0]?.checks);
  assert.equal(store.images(migrated.inputs[0]?.attachments ?? [])[0]?.data, legacyData);
  assert.ok(migrated.inputs[0]?.attachments[0]?.blob); assert.throws(() => store.validateNewImages(migrated.inputs[0]?.attachments), /base64|signature|MIME/);
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(migrated, store, agents);
  assert.equal(c.recordManualCheck({ commandId: 'original-action', expectedRevision: 0, sliceId: 'old-slice', checkId: 'old-check', passed: true, evidence: 'Human proof' }), 'human-acceptance');
  assert.deepEqual(store.load(), migrated);
});

test('G38 F21: legacy terminal bytes are backed up before reference metadata replaces inline image content', () => {
  const store = new Store(root()), name = `terminal-${createHash('sha256').update(draft.sessionId).digest('hex')}.json`;
  const bytes = JSON.stringify(draft, null, 2); writeFileSync(join(store.directory, name), bytes);
  assert.deepEqual(store.loadTerminal(draft.sessionId), draft); store.saveTerminal(draft);
  const saved = store.loadTerminal(draft.sessionId); assert.ok(saved?.builderAttachments?.[0]?.blob);
  assert.equal(store.images(saved.builderAttachments)[0]?.data, image.data);
  assert.equal(readFileSync(join(store.directory, name.replace(/\.json$/, '-v1-backup.json')), 'utf8'), bytes);
  const text = readFileSync(join(store.directory, name), 'utf8'); assert.ok(!text.includes(image.data)); assert.ok(text.includes('"version":2'));
});

test('G15/G37 F21: forged/corrupt image references fail before a new durable receipt can be accepted', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Explore');
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents); store.validateNewImages([image]); const ref = store.referenceImages([image])[0]; assert.ok(ref);
  for (const wrong of [{ ...ref, decodedBytes: 1 }, { ...ref, mimeType: 'image/jpeg' }, { ...ref, blob: { ...ref.blob, bytes: 1 } }]) {
    assert.throws(() => c.accept('Must not be saved', { attachments: [wrong] }), /metadata/);
    assert.equal(state.inputs.length, 0); assert.equal(state.conversation.length, 0);
  }
  writeFileSync(join(store.directory, 'payloads', `${ref.blob.sha256}.blob`), 'tampered');
  assert.throws(() => c.accept('Corrupt ref rejected', { attachments: [ref] }), /hash\/size/);
  assert.equal(state.inputs.length, 0); await c.close();
});

test('G37/G38 F21: maximum supported image payload lives outside repeatedly saved draft metadata', () => {
  const store = new Store(root()), bytes = Buffer.alloc(IMAGE_LIMITS.each); PNG.copy(bytes);
  const largest = { ...image, data: bytes.toString('base64') }; store.validateNewImages([largest, largest]);
  const references = store.referenceImages([largest, largest]);
  assert.equal(readdirSync(join(store.directory, 'payloads')).length, 1);
  store.saveTerminal({ ...draft, builderAttachments: references });
  const name = `terminal-${createHash('sha256').update(draft.sessionId).digest('hex')}.json`;
  const metadata = readFileSync(join(store.directory, name), 'utf8'); assert.ok(metadata.length < 2000);
  for (let n = 0; n < 100; n++) store.queueTerminal({ ...draft, builderDraft: `Typing ${n}`, builderAttachments: references });
  store.flushTerminal(); assert.equal(readdirSync(join(store.directory, 'payloads')).length, 1);
  assert.equal(store.loadTerminal(draft.sessionId)?.builderDraft, 'Typing 99'); assert.equal(store.images(references)[0]?.data, largest.data);
  store.close();
});

test('G37 F21 journal codec: storage sequences preserve same-revision metadata, exact ordering and reject malformed/conflicting deltas', () => {
  const state = Coordinator.initial(root(), 'Codec fixture'), reference = { sha256: 'a'.repeat(64), bytes: 2, encoding: 'json' as const };
  const first = validate(StoredIndexSchema, { ...state, intent: reference, archives: emptyArchives(), hasBuilderMessages: false,
    builderMessages: [], inputs: [{ id: 'one', body: reference }, { id: 'two', body: reference }] });
  const next = validate(StoredIndexSchema, { ...first, preference: 'technical', inputs: [{ id: 'three', body: reference }, { id: 'one', body: { ...reference, sha256: 'b'.repeat(64) } }] });
  const delta = indexDelta(first, next, 8); assert.equal(delta.sequence, 9); assert.equal(delta.fields.revision, undefined);
  assert.deepEqual(applyIndexDelta(first, delta, 8), next); assert.equal(first.inputs[0]?.body.sha256, 'a'.repeat(64));
  assert.throws(() => applyIndexDelta(first, delta, 7), /sequence conflict/);
  assert.throws(() => applyIndexDelta(first, { ...delta, sequence: 11 }, 8), /sequence conflict/);
  assert.throws(() => applyIndexDelta(first, { ...delta, fields: { id: 'different-project' } }, 8), /different project/);
  assert.throws(() => applyIndexDelta(first, { ...delta, authorized: true }, 8), /Invalid data/);
  assert.throws(() => applyIndexDelta(first, { ...delta, arrays: { inputs: { upsert: [], remove: ['missing'] } } }, 8), /unknown record/);
  assert.throws(() => applyIndexDelta(first, { ...delta, arrays: { inputs: { upsert: [], remove: [], order: ['one', 'one'] } } }, 8));
  assert.throws(() => applyIndexDelta(first, { ...delta, arrays: { inputs: { upsert: [], remove: [], order: ['one'] } } }, 8), /incomplete/);
  const used = validate(StoredIndexSchema, { ...first, usage: { companion: { tokens: 3, cost: null } } });
  const cleared = indexDelta(used, first, 9); assert.deepEqual(cleared.unsetFields, ['usage']); assert.deepEqual(applyIndexDelta(used, cleared, 9), first);
});

test('G37/G39 F21: rotated receipt/conversation windows retain cold identity lookup, search, paging and restart provenance', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Long history');
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents); const ids: string[] = [];
  for (let n = 0; n < 180; n++) { const id = c.accept(`Archived thought ${n}`); ids.push(id); c.cancelInput(id); }
  assert.equal(state.inputs.length, 128); assert.equal(state.archives?.inputs.count, 52); assert.equal(state.conversation.length, 128);
  for (const [position, id] of ids.entries()) { const saved = store.findInput(id); assert.equal(saved?.text, `Archived thought ${position}`); assert.equal(saved?.status, 'cancelled'); }
  assert.match(store.readRecordPage('conversation', 'Archived thought 0'), /Archived thought 0/);
  assert.match(store.readRecordPage('inputs', '', 4), /Archived thought 0/); assert.doesNotMatch(store.readRecordPage('inputs', '', 4), /Archived thought 179/);
  assert.ok(state.inputs.length + (state.archives?.inputs.count ?? 0) === 180); await c.close();
  const restarted = new Store(store.workspace), recovered = restarted.load(); assert.ok(recovered); assert.equal(recovered.inputs.length, 128);
  assert.equal(restarted.findInput(ids[0] ?? '')?.text, 'Archived thought 0'); assert.deepEqual(recovered.archives, state.archives);
});

test('G35/G37 F21: archived human command decisions remain idempotent after attempt window rotation', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Manual history');
  state.slices.push({ id: 'slice', status: 'completed', plan: { title: 'Inspect', goal: 'Inspect', requirements: ['Inspect'], decisionKeys: [], dependencies: [], assumptions: [], ready: false,
    acceptanceChecks: [{ kind: 'manual', criterion: 'Inspect' }] }, result: { status: 'completed', summary: 'Claim', verification: [], discoveries: [] },
    checks: [{ id: 'check', definition: { kind: 'manual', criterion: 'Inspect' }, status: 'passed', afterSequence: 0, latestResult: 'Proof 70', history: Array.from({ length: 70 }, (_value, n) => ({
      source: 'human' as const, commandId: `command-${n}`, receiptId: `receipt-${n}`, timestamp: n, status: 'passed' as const, evidence: `Proof ${n}` })) }] });
  store.save(state); assert.equal(state.slices[0]?.checks?.[0]?.history.length, 64); assert.equal(state.archives?.checkAttempts.count, 6);
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents);
  assert.equal(c.recordManualCheck({ commandId: 'command-0', expectedRevision: 0, sliceId: 'slice', checkId: 'check', passed: true, evidence: 'Proof 0' }), 'receipt-0');
  assert.throws(() => c.recordManualCheck({ commandId: 'command-0', expectedRevision: state.revision, sliceId: 'slice', checkId: 'check', passed: false, evidence: 'Conflicting' }), /conflicts/);
  assert.equal(state.inputs.length, 0); await c.close();
});

test('G37/G42 F21: pending input capacity rejects before acceptance while preserving every existing receipt', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Pending');
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents);
  for (let n = 0; n < 200; n++) c.accept(`Pending ${n}`);
  assert.throws(() => c.accept('Over capacity'), /200 inputs.*draft is retained/); assert.equal(state.inputs.length, 200);
  assert.equal(store.load()?.inputs.length, 200); await c.close();
});

test('G37/G42 F21: a failed journal acknowledgement never promotes an orphan archive tail; restart backs it up before reuse', async () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Archive fault');
  const agents: Agents = { build: async () => { throw new Error('No calls'); }, converse: async () => { throw new Error('No calls'); }, close() {} };
  const c = new Coordinator(state, store, agents);
  for (let n = 0; n < 128; n++) c.cancelInput(c.accept(`Original ${n}`));
  const latest = c.accept('Cancel acknowledgement will fail'), open = fs.openSync, append = fs.appendFileSync; let journal: number | undefined;
  state.sessions.builders = Array.from({ length: 80 }, (_value, n) => `Unacknowledged metadata ${n}`);
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => { const fd = open(path, flags, mode); if (String(path).endsWith('journal.jsonl')) journal = fd; return fd; });
  mock.method(fs, 'appendFileSync', (file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
    if (file === journal) { append(file, data.slice(0, 20), options); throw new Error('Journal ENOSPC after archive fsync'); } append(file, data, options);
  }); syncBuiltinESMExports();
  try { assert.throws(() => c.cancelInput(latest), /ENOSPC/); } finally { mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(state.archives?.inputs.count ?? 0, 0); assert.equal(state.metadataHead, undefined); await c.close();
  const ghost = { id: 'ghost', sessionId: state.currentSessionId, role: 'companion', mode: 'followUp', text: 'Never acknowledged ghost', attachments: [], status: 'accepted', timestamp: 1, updatedAt: 1, attempts: 0, edits: [] };
  const restarted = new Store(store.workspace), saved = restarted.load(); assert.ok(saved);
  assert.equal(saved.metadataHead, undefined); assert.doesNotMatch(restarted.readMetadataPage(), /Unacknowledged metadata/);
  const reference = { id: 'ghost', body: restarted.putPayload(JSON.stringify(ghost), 'json') };
  fs.appendFileSync(join(restarted.directory, 'archive-inputs.jsonl'), JSON.stringify(reference) + '\n');
  assert.equal(restarted.findInput('ghost'), undefined);
  const recovered = new Coordinator(saved, restarted, agents); recovered.recover();
  assert.equal(restarted.findInput('ghost'), undefined); assert.equal(saved.inputs.find(input => input.id === latest)?.status, 'interrupted');
  assert.ok(readdirSync(restarted.directory).some(name => name.startsWith('interrupted-inputs-'))); await recovered.close();
});

test('G22/G37/G42 F21: intermediate updates coalesce within 150ms, final raw output is lossless and timer failures surface', () => {
  const store = new Store(root()); mock.timers.enable({ apis: ['setTimeout'] });
  try {
    store.event({ sliceId: 'slice', event: { type: 'tool_execution_start', toolCallId: 'operation', toolName: 'bash', args: { command: 'node test.mjs' } } });
    const before = fs.statSync(join(store.directory, 'builder-events.jsonl')).size;
    for (let n = 0; n < 100; n++) store.event({ sliceId: 'slice', event: { type: 'tool_execution_update', toolCallId: 'operation', toolName: 'bash', partialResult: { content: [{ type: 'text', text: `Update ${n}` }] } } });
    assert.equal(fs.statSync(join(store.directory, 'builder-events.jsonl')).size, before); mock.timers.tick(149);
    assert.equal(fs.statSync(join(store.directory, 'builder-events.jsonl')).size, before); mock.timers.tick(1);
    const lines = readFileSync(join(store.directory, 'builder-events.jsonl'), 'utf8').trim().split('\n'); assert.equal(lines.length, 2);
    const update: unknown = JSON.parse(lines[1] ?? 'null'); assert.ok(update && typeof update === 'object' && 'payloadRef' in update);
    assert.match(store.readPayload(update.payloadRef), /Update 99/);
    const output = 'Lossless final '.repeat(5000) + 'FINAL END';
    const ref = store.event({ sliceId: 'slice', event: { type: 'tool_execution_end', toolCallId: 'operation', toolName: 'bash', isError: false, result: { content: [{ type: 'text', text: output }] } } });
    assert.ok(ref); assert.ok(store.readPayload(ref).includes(output));
    let failures = 0; store.onStorageFailure(() => { failures++; });
    const sync = fs.fsyncSync; mock.method(fs, 'fsyncSync', () => { throw new Error('Buffered event ENOSPC'); }); syncBuiltinESMExports();
    store.event({ sliceId: 'slice', event: { type: 'tool_execution_update', toolCallId: 'failed-operation', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'Failure update' }] } } });
    mock.timers.tick(150); assert.equal(failures, 1); mock.restoreAll(); syncBuiltinESMExports(); assert.equal(fs.fsyncSync, sync); store.flushEvents();
  } finally { mock.restoreAll(); syncBuiltinESMExports(); store.close(); mock.timers.reset(); }
});
