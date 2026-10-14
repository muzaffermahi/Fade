import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, mkdirSync,
  renameSync, unlinkSync, writeFileSync, writeSync, fstatSync, readSync, ftruncateSync, lstatSync, constants } from 'node:fs';
import { relative, resolve } from 'node:path';
import { randomUUID, createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { executionLog, sliceReport } from './reports.js';
import { IntentSchema, InputReceiptSchema, ConversationSchema, ArchivedCheckAttemptSchema, LegacyStateSchema, V2StateSchema, V3StateSchema, V4StateSchema, StateSchema, StoredIndexSchema, RecordReferenceSchema, JournalEnvelopeSchema, TerminalStateSchema, StoredTerminalSchema, InlineAttachmentSchema, ImageReferenceSchema, AttachmentSchema, PayloadReferenceSchema, validate, type WorkEvent, type ArchiveCollection, type ArchiveManifest, type JournalEnvelope, type StoredIndex, type RecordReference, type InlineAttachment, type InputReceipt, type PayloadReference, type ProjectState, type TerminalState } from './contracts.js';
import { prepareChecks, acceptanceStatus } from './checks.js';
import { captureWorkspace, WorkspaceSnapshotSchema, renderChanges } from './changes.js';
import { ProtectedStatePaths, StateIntegrityError } from './workspace.js';
import { DRAFT_SAVE_DELAY, imageBytes, validateImages, IMAGE_LIMITS, STORAGE_LIMITS, INDEX_COLLECTIONS, emptyArchives, indexDelta, applyIndexDelta, operationSummary, type IndexCollection } from './payloads.js';
import { Type } from 'typebox';
import { MetadataBlockSchema, type MetadataEntry } from './contracts.js';
const ImagesSchema = Type.Array(AttachmentSchema, { maxItems: IMAGE_LIMITS.count });
const PayloadStringSchema = Type.String();

function savedState(value: unknown) {
  if (!value || typeof value !== 'object' || !('version' in value)) throw new Error('Saved state has no supported version.');
  if (value.version === 1) return validate(LegacyStateSchema, value);
  if (value.version === 2) return validate(V2StateSchema, value);
  if (value.version === 3) return validate(V3StateSchema, value);
  if (value.version === 4) return validate(V4StateSchema, value);
  return validate(StateSchema, value);
}
/** Pure conservative migration; Store backs up original bytes before saving this result. */
export function migrateConversation(saved: ReturnType<typeof savedState>): ProjectState {
  if (saved.version === 5) return structuredClone(saved);
  const legacy = saved.version === 1;
  const old = saved.version === 2 || saved.version === 3 || saved.version === 4 ? saved : validate(V2StateSchema, { ...saved, version: 2, currentSessionId: saved.id,
    inputs: [...saved.conversation.filter(message => message.role === 'human').map(message => ({ id: message.id, sessionId: saved.id, role: 'companion',
      mode: 'followUp', text: message.text, attachments: [], status: 'interrupted', timestamp: message.timestamp, updatedAt: message.timestamp,
      attempts: 0, edits: [], error: 'Legacy processing and native session are unknown. Inspect before explicitly retrying.' })),
      ...(saved.builderMessages ?? []).map(message => ({ id: message.id, sessionId: saved.id, role: 'builder', mode: 'steer', text: message.text,
        attachments: [], status: message.status === 'received' ? 'processed' : 'interrupted', timestamp: message.timestamp, updatedAt: message.timestamp, attempts: 0, edits: [] }))],
    workEvents: [], verificationEvidence: [], ownership: { owner: null, operation: null, transfer: null, interrupted: true } });
  if (!Number.isSafeInteger(old.revision + 1)) throw new Error('Migration revision exceeds safe integer range.');
  return validate(StateSchema, { ...old, version: 5, revision: old.revision + 1, mode: 'paused',
    ownership: { owner: null, operation: null, transfer: null, interrupted: true },
    slices: old.slices.map(slice => ({ ...slice, status: slice.status === 'running' ? 'interrupted' : slice.status,
      checks: 'checks' in slice ? slice.checks : prepareChecks(slice.plan, old.workEvents.filter(event => event.sliceId === slice.id).at(-1)?.sequence ?? 0) })),
    inputs: old.inputs.map(input => ['accepted', 'queued', 'processing'].includes(input.status) ? { ...input, status: 'interrupted',
      error: input.error ?? 'Recovered during session migration; delivery is uncertain. Inspect before explicitly retrying.' } : input),
    conversation: old.conversation.map(message => {
      if ('scope' in message) return message;
      const matches = legacy ? [] : old.inputs.filter(input => input.id === message.id && message.role === 'human' && input.text === message.text
        && (!message.targetRole || message.targetRole === input.role));
      const input = matches.length === 1 ? matches[0] : undefined;
      return input ? { ...message, scope: 'session', sessionId: input.sessionId, receiptId: input.id, targetRole: message.targetRole ?? input.role }
        : { ...message, scope: 'project_history', historyReason: legacy ? 'Legacy conversation has no proven native session.' : 'Legacy record has no uniquely proven session/receipt association.' };
    }) });
}

/** One process owns a workspace; a durable journal is authoritative after a crash. */
export class Store {
  readonly directory: string;
  private readonly paths: ProtectedStatePaths;
  private readonly tracked = new Map<string, string | undefined>();
  private integrityError: StateIntegrityError | undefined;
  private lockIdentity: string | undefined;
  private readonly drafts = new Map<string, { state: TerminalState; onError?: (error: unknown) => void }>();
  private draftTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly payloadStamps = new Map<string, string>();
  private readonly imageSignatures = new Map<string, { stamp: string; mime: string; bytes: number; encodedBytes: number }>();
  private readonly verifiedInline = new WeakMap<object, { data: string; mime: string; bytes: number }>();
  private readonly recordCache = new Map<string, { text: string; reference: RecordReference; bytes: number; stamp: string }>();
  private recordCacheBytes = 0;
  private latestIndex: StoredIndex | undefined;
  private journalSequence = 0;
  private readonly archiveHashes = new Map<ArchiveCollection, { bytes: number; sha256: string; hash: Hash }>();
  private readonly pendingEvents = new Map<string, string>();
  private pendingEventBytes = 0;
  /** Local numeric budgets only; no private payload text enters performance/diagnostic measurements. */
  storageMetrics() {
    return { recordCacheEntries: this.recordCache.size, recordCacheBytes: this.recordCacheBytes, payloadCacheEntries: this.payloadStamps.size,
      imageCacheEntries: this.imageSignatures.size, pendingEventEntries: this.pendingEvents.size, pendingEventBytes: this.pendingEventBytes,
      hotRecords: this.latestIndex ? Object.fromEntries(INDEX_COLLECTIONS.map(collection => [collection, this.latestIndex?.[collection].length ?? 0])) : {} };
  }
  private eventTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly storageObservers = new Set<(error: unknown) => void>();
  onStorageFailure(observer: (error: unknown) => void): () => void { this.storageObservers.add(observer); return () => this.storageObservers.delete(observer); }
  private lockOwned = false;
  private saves = 0;
  readonly diagnostics: string[] = [];
  private diagnostic(error: unknown): void {
    this.diagnostics.push(error instanceof Error ? error.message : String(error));
    if (this.diagnostics.length > 50) this.diagnostics.shift();
  }
  private readonly observers = new Set<() => void>();
  /** Renderers subscribe to state saves and cannot change acceptance semantics. */
  subscribe(observer: () => void): () => void { this.observers.add(observer); return () => this.observers.delete(observer); }
  constructor(readonly workspace: string) {
    this.paths = new ProtectedStatePaths(workspace);
    this.workspace = this.paths.workspace; this.directory = this.paths.directory;
    this.remember();
  }
  private path(name: string): string { return this.paths.path(name); }
  private stamp(name: string): string | undefined {
    const path = this.paths.file(name);
    try { const stat = lstatSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`; }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error; }
  }
  private remember(): void {
    for (const name of ['journal.jsonl', 'checkpoint.json', 'builder-events.jsonl']) this.tracked.set(name, this.stamp(name));
  }
  /** Check before writes and provider boundaries; never silently bless an external edit. */
  assertIntegrity(): void {
    if (this.integrityError) throw this.integrityError;
    try {
      if (this.lockOwned && this.stamp('lock') !== this.lockIdentity) throw new StateIntegrityError('Workspace lock changed while owned.');
      for (const [name, expected] of this.tracked) if (this.stamp(name) !== expected) throw new StateIntegrityError(`Coordinator state changed outside Store: ${name}. Inspect before restarting.`);
      for (const name of ['lock', 'state.json', 'intent.json', 'intent.md']) this.path(name);
      this.paths.directoryTree('sessions', false);
    } catch (error) { if (error instanceof StateIntegrityError) this.integrityError = error; throw error; }
  }
  /** Public Pi integration keeps stock tools while validating protected session paths. */
  sessionDirectory(role: 'builder' | 'companion' | 'conversation'): string {
    this.assertIntegrity(); return this.paths.directoryTree(`sessions/${role}`);
  }
  private open(name: string, flags: number | string): number {
    const fd = openSync(this.paths.file(name), flags, 0o600);
    try { this.paths.opened(name, fd); return fd; } catch (error) { closeSync(fd); throw error; }
  }
  private read(name: string): string {
    const fd = this.open(name, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return readFileSync(fd, 'utf8'); } finally { closeSync(fd); }
  }
  private payloadName(reference: PayloadReference): string {
    validate(PayloadReferenceSchema, reference); return `payloads/${reference.sha256}.blob`;
  }
  private rememberPayload(reference: PayloadReference): void {
    const stamp = this.stamp(this.payloadName(reference));
    if (!stamp) throw new StateIntegrityError('Payload disappeared after persistence.');
    this.payloadStamps.delete(reference.sha256); this.payloadStamps.set(reference.sha256, stamp);
    if (this.payloadStamps.size > 256) { const first = this.payloadStamps.keys().next().value; if (first) this.payloadStamps.delete(first); }
  }
  /** Lossless encoded payload bytes, exclusive creation and fsync precede every index reference. */
  putPayload(text: string, encoding: PayloadReference['encoding'] = 'json'): PayloadReference {
    this.assertIntegrity();
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.toString('utf8') !== text) throw new Error('Payload must be UTF-8; JSON-encode strings containing unpaired surrogates.');
    const reference = validate(PayloadReferenceSchema, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length, encoding });
    const directory = this.path('payloads'); if (!existsSync(directory)) mkdirSync(directory);
    if (!lstatSync(this.path('payloads')).isDirectory()) throw new StateIntegrityError('Payload storage is not a directory.');
    const name = this.payloadName(reference);
    if (existsSync(this.path(name))) {
      if (this.payloadStamps.get(reference.sha256) !== this.stamp(name)) this.readPayload(reference);
      this.rememberPayload(reference); return reference;
    }
    const fd = this.open(name, 'wx');
    try { writeFileSync(fd, bytes); this.paths.opened(name, fd); fsyncSync(fd); }
    catch (error) {
      // No committed index references this new file. Remove only the descriptor we still own.
      try { this.paths.opened(name, fd); unlinkSync(this.path(name)); } catch { /* Preserve replacements for inspection. */ }
      throw error;
    } finally { closeSync(fd); }
    this.rememberPayload(reference); return reference;
  }
  /** Bounded unchanged-record cache avoids repeating hash/filesystem work for an identical body. */
  private recordReference(collection: string, id: string, value: unknown): RecordReference {
    const text = JSON.stringify(value); if (text === undefined) throw new Error('Stored record body must be JSON.');
    const key = `${collection}\0${id}`, cached = this.recordCache.get(key);
    if (cached?.text === text) {
      this.recordCache.delete(key); this.recordCache.set(key, cached); return cached.reference;
    }
    if (cached) { this.recordCache.delete(key); this.recordCacheBytes -= cached.bytes; }
    const reference = { id, body: this.putPayload(text, 'json') }, bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= STORAGE_LIMITS.recordCacheBytes) {
      const stamp = this.stamp(this.payloadName(reference.body)); if (!stamp) throw new StateIntegrityError('Stored record body disappeared.');
      this.recordCache.set(key, { text, reference, bytes, stamp }); this.recordCacheBytes += bytes;
      while (this.recordCache.size > STORAGE_LIMITS.recordCacheEntries || this.recordCacheBytes > STORAGE_LIMITS.recordCacheBytes) {
        const first = this.recordCache.entries().next().value; if (!first) break;
        this.recordCache.delete(first[0]); this.recordCacheBytes -= first[1].bytes;
      }
    }
    return reference;
  }
  private verifyRecordCache(): void {
    const entries = [...this.recordCache.values()], names = entries.map(entry => this.payloadName(entry.reference.body));
    const stats = this.paths.files(names);
    for (const entry of entries) {
      const stat = stats.get(this.payloadName(entry.reference.body));
      const actual = stat ? `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : undefined;
      if (actual !== entry.stamp) throw new StateIntegrityError(`Stored record body changed outside Store: ${entry.reference.id}.`);
    }
  }
  private records(state: ProjectState, collection: IndexCollection): unknown[] {
    switch (collection) {
      case 'inputs': return state.inputs;
      case 'conversation': return state.conversation;
      case 'slices': return state.slices;
      case 'workEvents': return state.workEvents;
      case 'verificationEvidence': return state.verificationEvidence;
      case 'history': return state.history;
      case 'discoveries': return state.discoveries;
      case 'builderMessages': return state.builderMessages ?? [];
    }
  }
  private recordId(collection: IndexCollection, value: unknown, position: number): string {
    if (collection === 'history' || collection === 'discoveries') return `${collection}:${position}`;
    if (value && typeof value === 'object') {
      if ((collection === 'workEvents' || collection === 'verificationEvidence') && 'sliceId' in value && typeof value.sliceId === 'string'
        && 'sequence' in value && typeof value.sequence === 'number') return `${value.sliceId}/${value.sequence}`;
      if ('id' in value && typeof value.id === 'string') return value.id;
    }
    throw new Error(`Stored ${collection} record has no valid identity.`);
  }
  private digestReference(value: unknown): PayloadReference {
    const text = JSON.stringify(value); if (text === undefined) throw new Error('Stored body must be JSON.');
    return { sha256: createHash('sha256').update(text, 'utf8').digest('hex'), bytes: Buffer.byteLength(text, 'utf8'), encoding: 'json' };
  }
  /** Persist only changed immutable bodies; a compact index remains independent of their size. */
  private indexFor(state: ProjectState, persist = true): StoredIndex {
    validate(StateSchema, state);
    const archives = state.archives ?? emptyArchives();
    const encode = (collection: IndexCollection): RecordReference[] => {
      const references = this.records(state, collection).map((record, position) => {
        const id = this.recordId(collection, record, archives[collection].count + position);
        return persist ? this.recordReference(collection, id, record) : { id, body: this.digestReference(record) };
      });
      if (new Set(references.map(reference => reference.id)).size !== references.length) throw new Error(`Duplicate ${collection} record identity.`);
      return references;
    };
    return validate(StoredIndexSchema, { version: state.version, id: state.id, workspace: state.workspace, revision: state.revision,
      mode: state.mode, preference: state.preference, remainingSlices: state.remainingSlices,
      ...(state.runLimit !== undefined ? { runLimit: state.runLimit } : {}), currentSessionId: state.currentSessionId,
      intent: persist ? this.recordReference('scalar', 'intent', state.intent).body : this.digestReference(state.intent),
      ownership: state.ownership, sessions: state.sessions, ...(state.usage ? { usage: state.usage } : {}),
      ...(state.metadataHead ? { metadataHead: state.metadataHead } : {}), archives,
      hasBuilderMessages: state.builderMessages !== undefined, inputs: encode('inputs'), conversation: encode('conversation'), slices: encode('slices'),
      workEvents: encode('workEvents'), verificationEvidence: encode('verificationEvidence'), history: encode('history'), discoveries: encode('discoveries'), builderMessages: encode('builderMessages') });
  }
  private archiveName(collection: ArchiveCollection): string { return `archive-${collection}.jsonl`; }
  private archiveHash(collection: ArchiveCollection, boundary: ArchiveManifest[ArchiveCollection]): Hash {
    const cached = this.archiveHashes.get(collection);
    if (cached && cached.bytes === boundary.bytes && cached.sha256 === boundary.sha256) return cached.hash.copy();
    const hash = createHash('sha256');
    if (boundary.bytes) {
      const name = this.archiveName(collection); if (!this.tracked.has(name)) this.tracked.set(name, this.stamp(name));
      const fd = this.open(name, 'r');
      try {
        if (fstatSync(fd).size < boundary.bytes) throw new StateIntegrityError('Committed archive was truncated.');
        const buffer = Buffer.alloc(65536); let offset = 0;
        while (offset < boundary.bytes) { const read = readSync(fd, buffer, 0, Math.min(buffer.length, boundary.bytes - offset), offset); if (!read) throw new StateIntegrityError('Archive read ended early.'); hash.update(buffer.subarray(0, read)); offset += read; }
      } finally { closeSync(fd); }
    }
    if (hash.copy().digest('hex') !== boundary.sha256) throw new StateIntegrityError(`Committed ${collection} archive checksum mismatch.`);
    this.archiveHashes.set(collection, { ...boundary, hash: hash.copy() }); return hash;
  }
  private appendArchive(collection: ArchiveCollection, references: RecordReference[], boundary: ArchiveManifest[ArchiveCollection]) {
    if (!references.length) return boundary;
    const hash = this.archiveHash(collection, boundary), name = this.archiveName(collection);
    if (!this.tracked.has(name)) this.tracked.set(name, this.stamp(name));
    const fd = this.open(name, existsSync(this.path(name)) ? 'r+' : 'wx+');
    try {
      const size = fstatSync(fd).size; if (size < boundary.bytes) throw new StateIntegrityError('Committed archive was truncated.');
      if (size > boundary.bytes) {
        const backup = this.open(`interrupted-${collection}-${randomUUID()}.jsonl`, 'wx');
        try {
          const buffer = Buffer.alloc(65536); let offset = boundary.bytes;
          while (offset < size) { const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset); if (!read) throw new Error('Interrupted archive read ended early.'); writeFileSync(backup, buffer.subarray(0, read)); offset += read; }
          fsyncSync(backup);
        } finally { closeSync(backup); }
        this.paths.opened(name, fd); ftruncateSync(fd, boundary.bytes); fsyncSync(fd);
      }
      const text = references.map(reference => JSON.stringify(validate(RecordReferenceSchema, reference)) + '\n').join('');
      const encoded = Buffer.from(text, 'utf8'); let written = 0;
      while (written < encoded.length) { const count = writeSync(fd, encoded, written, encoded.length - written, boundary.bytes + written); if (!count) throw new Error('Archive write made no progress.'); written += count; }
      this.paths.opened(name, fd); fsyncSync(fd); hash.update(text, 'utf8');
      const next = { bytes: boundary.bytes + Buffer.byteLength(text, 'utf8'), count: boundary.count + references.length, sha256: hash.copy().digest('hex') };
      this.archiveHashes.set(collection, { ...next, hash: hash.copy() }); this.tracked.set(name, this.stamp(name)); return next;
    } finally { closeSync(fd); }
  }
  private keepWindow<T>(records: T[], limit: number, pinned: (record: T) => boolean): { keep: T[]; drop: T[] } {
    const ordinary = records.map((record, position) => ({ record, position })).filter(item => !pinned(item.record));
    const tail = new Set(ordinary.slice(-limit).map(item => item.position));
    return { keep: records.filter((record, position) => pinned(record) || tail.has(position)), drop: records.filter((record, position) => !pinned(record) && !tail.has(position)) };
  }
  /** Cold records are archived before the candidate index is acknowledged; live authority/evidence is pinned. */
  private workingSet(state: ProjectState): ProjectState {
    const archives = structuredClone(state.archives ?? emptyArchives());
    const candidate = { ...state };
    const metadata: MetadataEntry[] = [];
    const decisions = this.keepWindow(state.intent.decisions, STORAGE_LIMITS.supersededDecisions, decision => decision.status !== 'superseded');
    for (const decision of decisions.drop) metadata.push({ kind: 'decision', decision });
    if (decisions.drop.length) candidate.intent = { ...state.intent, decisions: decisions.keep };
    const oldSessions = state.sessions.builders.slice(0, Math.max(0, state.sessions.builders.length - STORAGE_LIMITS.builderSessions));
    for (const path of oldSessions) metadata.push({ kind: 'builderSession', path });
    if (oldSessions.length) candidate.sessions = { ...state.sessions, builders: state.sessions.builders.slice(-STORAGE_LIMITS.builderSessions) };
    candidate.inputs = state.inputs.map(input => {
      const oldEdits = input.edits.slice(0, Math.max(0, input.edits.length - STORAGE_LIMITS.inputEdits));
      for (const edit of oldEdits) metadata.push({ kind: 'inputEdit', receiptId: input.id, ...edit });
      return oldEdits.length ? { ...input, edits: input.edits.slice(-STORAGE_LIMITS.inputEdits) } : input;
    });
    for (let offset = 0; offset < metadata.length; offset += 128) {
      const block = validate(MetadataBlockSchema, { ...(candidate.metadataHead ? { previous: candidate.metadataHead } : {}), entries: metadata.slice(offset, offset + 128) });
      candidate.metadataHead = this.putPayload(JSON.stringify(block), 'json');
    }
    const liveSlices = state.slices.filter(slice => !['completed', 'cancelled'].includes(slice.status));
    if (liveSlices.length > 128) throw new Error('More than 128 unresolved slices require inspection/cancellation before new work; saved data is preserved.');
    const sliceIds = new Set(liveSlices.map(slice => slice.id));
    for (const slice of liveSlices) for (const id of slice.plan.dependencies) sliceIds.add(id);
    const sources = new Set(state.intent.decisions.filter(decision => decision.status !== 'superseded').map(decision => decision.sourceId));
    const pendingNotes = new Set((state.builderMessages ?? []).filter(note => note.status !== 'received').map(note => note.id));
    const liveInputs = new Set(state.inputs.filter(input => ['accepted', 'queued', 'processing'].includes(input.status) || pendingNotes.has(input.id)).map(input => input.id));
    const archive = (collection: IndexCollection, records: unknown[], limit: number, pinned: (record: unknown) => boolean): unknown[] => {
      const selected = this.keepWindow(records, limit, pinned);
      const references = selected.drop.map((record, position) => this.recordReference(collection,
        this.recordId(collection, record, archives[collection].count + position), record));
      archives[collection] = this.appendArchive(collection, references, archives[collection]); return selected.keep;
    };
    const inputRows = this.keepWindow(candidate.inputs, STORAGE_LIMITS.receipts, input => liveInputs.has(input.id) || sources.has(input.id));
    archives.inputs = this.appendArchive('inputs', inputRows.drop.map(input => this.recordReference('inputs', input.id, input)), archives.inputs); candidate.inputs = inputRows.keep;
    const conversations = this.keepWindow(state.conversation, STORAGE_LIMITS.conversation, message => sources.has(message.id) || liveInputs.has(message.id)
      || ('receiptId' in message && message.receiptId !== undefined && liveInputs.has(message.receiptId)));
    archives.conversation = this.appendArchive('conversation', conversations.drop.map(message => this.recordReference('conversation', message.id, message)), archives.conversation); candidate.conversation = conversations.keep;
    const slices = this.keepWindow(state.slices, STORAGE_LIMITS.slices, slice => sliceIds.has(slice.id));
    archives.slices = this.appendArchive('slices', slices.drop.map(slice => this.recordReference('slices', slice.id, slice)), archives.slices); candidate.slices = slices.keep;
    const oldAttempts: RecordReference[] = [];
    for (const slice of slices.drop) for (const check of slice.checks ?? []) for (const attempt of check.history) {
      const reference = this.recordReference('checkAttempts', `${slice.id}/${check.id}/${attempt.source === 'human' ? attempt.commandId : attempt.sequence}`,
        validate(ArchivedCheckAttemptSchema, { sliceId: slice.id, checkId: check.id, attempt }));
      oldAttempts.push({ ...reference, ...(attempt.source === 'human' ? { lookup: attempt.commandId } : {}) });
    }
    candidate.slices = candidate.slices.map(slice => !slice.checks?.some(check => check.history.length > STORAGE_LIMITS.attempts) ? slice : ({ ...slice, checks: slice.checks.map(check => {
      for (const attempt of check.history.slice(0, Math.max(0, check.history.length - STORAGE_LIMITS.attempts))) {
        const id = `${slice.id}/${check.id}/${attempt.source === 'human' ? attempt.commandId : attempt.sequence}`;
        const reference = this.recordReference('checkAttempts', id, validate(ArchivedCheckAttemptSchema, { sliceId: slice.id, checkId: check.id, attempt }));
        oldAttempts.push({ ...reference, ...(attempt.source === 'human' ? { lookup: attempt.commandId } : {}) });
      }
      return check.history.length > STORAGE_LIMITS.attempts ? { ...check, history: check.history.slice(-STORAGE_LIMITS.attempts) } : check;
    }) }));
    archives.checkAttempts = this.appendArchive('checkAttempts', oldAttempts, archives.checkAttempts);
    const recentOperations = new Set(state.workEvents.slice(-STORAGE_LIMITS.work).filter(event => event.operationId).map(event => `${event.sliceId}\0${event.operationId}`));
    const open = new Map<string, boolean>(); for (const event of state.workEvents) if (event.operationId && ['tool_start', 'tool_end'].includes(event.type)) open.set(`${event.sliceId}\0${event.operationId}`, event.type === 'tool_start');
    const work = this.keepWindow(state.workEvents, STORAGE_LIMITS.work, event => event.type === 'tool_start' && (recentOperations.has(`${event.sliceId}\0${event.operationId}`) || open.get(`${event.sliceId}\0${event.operationId}`) === true));
    archives.workEvents = this.appendArchive('workEvents', work.drop.map(event => this.recordReference('workEvents', `${event.sliceId}/${event.sequence}`, event)), archives.workEvents); candidate.workEvents = work.keep;
    const latestShell = new Map<string, ProjectState['verificationEvidence'][number]>();
    for (const evidence of state.verificationEvidence) if (['bash', 'powershell'].includes(evidence.toolName)) {
      const input = evidence.input, args = input && typeof input === 'object' && 'args' in input && input.args && typeof input.args === 'object' ? input.args : undefined;
      const command = args && 'command' in args && typeof args.command === 'string' ? args.command.trim() : '';
      latestShell.set(`${evidence.sliceId}\0${evidence.toolName}\0${evidence.commandHash ?? (command ? `command:${command}` : `unknown:${evidence.sequence}`)}`, evidence);
    }
    const failures = new Set([...latestShell.values()].filter(evidence => evidence.isError && sliceIds.has(evidence.sliceId)));
    const verification = this.keepWindow(state.verificationEvidence, STORAGE_LIMITS.verification, evidence => failures.has(evidence));
    archives.verificationEvidence = this.appendArchive('verificationEvidence', verification.drop.map(evidence => this.recordReference('verificationEvidence', `${evidence.sliceId}/${evidence.sequence}`, evidence)), archives.verificationEvidence); candidate.verificationEvidence = verification.keep;
    candidate.history = validate(StateSchema.properties.history, archive('history', state.history, STORAGE_LIMITS.history, () => false));
    candidate.discoveries = validate(StateSchema.properties.discoveries, archive('discoveries', state.discoveries, STORAGE_LIMITS.discoveries, () => false));
    if (state.builderMessages) candidate.builderMessages = validate(StateSchema.properties.builderMessages, archive('builderMessages', state.builderMessages, STORAGE_LIMITS.notes,
      record => Boolean(record && typeof record === 'object' && 'status' in record && record.status !== 'received')));
    if (Object.values(archives).some(boundary => boundary.count)) candidate.archives = archives;
    return validate(StateSchema, candidate);
  }
  /** Bounded line iteration never reads beyond an acknowledged archive prefix. */
  private *archiveReferences(collection: ArchiveCollection, reverse = false): Generator<RecordReference> {
    const boundary = this.latestIndex?.archives[collection]; if (!boundary?.bytes) return;
    this.assertIntegrity(); this.archiveHash(collection, boundary);
    const fd = this.open(this.archiveName(collection), 'r');
    try {
      if (reverse) {
        let offset = boundary.bytes, pending = Buffer.alloc(0), skippedEnd = false;
        while (offset > 0) {
          const length = Math.min(65536, offset); offset -= length; const chunk = Buffer.alloc(length); readSync(fd, chunk, 0, length, offset); pending = Buffer.concat([chunk, pending]);
          if (!skippedEnd) { if (pending.at(-1) !== 10) throw new StateIntegrityError('Committed archive has a partial tail.'); pending = pending.subarray(0, pending.length - 1); skippedEnd = true; }
          let newline: number;
          while ((newline = pending.lastIndexOf(10)) >= 0) { const line = pending.subarray(newline + 1).toString('utf8'); pending = pending.subarray(0, newline); yield validate(RecordReferenceSchema, JSON.parse(line)); }
        }
        if (pending.length) yield validate(RecordReferenceSchema, JSON.parse(pending.toString('utf8'))); return;
      }
      let offset = 0, pending = Buffer.alloc(0); const chunk = Buffer.alloc(65536);
      while (offset < boundary.bytes) {
        const count = readSync(fd, chunk, 0, Math.min(chunk.length, boundary.bytes - offset), offset); if (!count) throw new StateIntegrityError('Archive read ended early.'); offset += count;
        pending = Buffer.concat([pending, chunk.subarray(0, count)]); let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = pending.subarray(0, newline).toString('utf8'); pending = pending.subarray(newline + 1);
          yield validate(RecordReferenceSchema, JSON.parse(line));
        }
      }
      if (pending.length) throw new StateIntegrityError('Committed archive ends with a partial record.');
    } finally { closeSync(fd); }
  }
  private findReference(collection: IndexCollection, id: string): RecordReference | undefined {
    const hot = this.latestIndex?.[collection].find(reference => reference.id === id); if (hot) return hot;
    let found: RecordReference | undefined; for (const reference of this.archiveReferences(collection)) if (reference.id === id) found = reference; return found;
  }
  findInput(id: string): InputReceipt | undefined {
    const reference = this.findReference('inputs', id); if (!reference) return undefined;
    const input = validate(InputReceiptSchema, this.jsonPayload(reference.body)); if (input.id !== id) throw new StateIntegrityError('Archived input identity mismatch.'); return input;
  }
  findConversation(id: string) {
    const reference = this.findReference('conversation', id); if (!reference) return undefined;
    const message = validate(ConversationSchema, this.jsonPayload(reference.body)); if (message.id !== id) throw new StateIntegrityError('Archived conversation identity mismatch.'); return message;
  }
  /** Restore at most one reading page with a single cold-index scan and only requested body reads. */
  findConversations(ids: readonly string[]) {
    if (ids.length > 64) throw new Error('Reading page is limited to 64 conversation records.');
    const wanted = new Set(ids), references = new Map<string, RecordReference>();
    for (const reference of this.latestIndex?.conversation ?? []) if (wanted.has(reference.id)) { references.set(reference.id, reference); wanted.delete(reference.id); }
    if (wanted.size) for (const reference of this.archiveReferences('conversation', true)) {
      if (wanted.has(reference.id)) { references.set(reference.id, reference); wanted.delete(reference.id); }
      if (!wanted.size) break;
    }
    return ids.flatMap(id => {
      const reference = references.get(id); if (!reference) return [];
      const message = validate(ConversationSchema, this.jsonPayload(reference.body)); if (message.id !== id) throw new StateIntegrityError('Archived conversation identity mismatch.'); return [message];
    });
  }
  findSlice(id: string) {
    const reference = this.findReference('slices', id); if (!reference) return undefined;
    const slice = validate(StateSchema.properties.slices.items, this.jsonPayload(reference.body)); if (slice.id !== id) throw new StateIntegrityError('Archived slice identity mismatch.'); return slice;
  }
  findManualAction(commandId: string) {
    let found: ReturnType<typeof validate<typeof ArchivedCheckAttemptSchema>> | undefined;
    for (const reference of this.archiveReferences('checkAttempts')) if (reference.lookup === commandId) {
      const record = validate(ArchivedCheckAttemptSchema, this.jsonPayload(reference.body));
      if (record.attempt.source !== 'human' || record.attempt.commandId !== commandId) throw new StateIntegrityError('Archived human command identity mismatch.'); found = record;
    }
    return found;
  }
  /** Latest page first; search scans retained history with only the requested bounded window in memory. */
  readRecordPage(collection: IndexCollection, query = '', page = 0, sessionId?: string): string {
    if (!Number.isSafeInteger(page) || page < 0 || page > 1000) throw new Error('History page must be between 0 and 1000; use search for older records.');
    const rows: string[] = [], seen = new Set<string>(); let skipped = 0;
    const hot = this.latestIndex?.[collection] ?? [];
    const identity = (id: string) => createHash('sha256').update(id, 'utf8').digest('hex');
    const hotIds = new Set(hot.map(reference => identity(reference.id)));
    const accept = (reference: RecordReference): boolean => {
      const key = identity(reference.id) + reference.body.sha256;
      if (seen.has(key)) return false;
      const value = this.jsonPayload(reference.body);
      if (sessionId && value && typeof value === 'object' && (!('sessionId' in value) || value.sessionId !== sessionId)) return false;
      const text = this.recordText(collection, value); if (!text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) return false;
      // Only matches need deduplication: at most (page + 1) * 40 fixed-size keys.
      // Distinct committed cold versions retain their own historical provenance.
      seen.add(key);
      if (skipped < page * 40) { skipped++; return false; }
      rows.push(text); return rows.length === 40;
    };
    let full = false;
    for (const reference of [...hot].reverse()) if (accept(reference)) { full = true; break; }
    if (!full) for (const reference of this.archiveReferences(collection, true)) if (!hotIds.has(identity(reference.id)) && accept(reference)) break;
    return `${collection} history · latest page ${page} · ${rows.length} records · page:N <search> reads retained history\n\n` + (rows.reverse().join('\n\n') || 'No matching records.');
  }
  private recordText(collection: IndexCollection, value: unknown): string {
    if (collection === 'inputs') { const input = validate(InputReceiptSchema, value); return `${input.id} · ${input.role}/${input.mode} · ${input.status} · session ${input.sessionId}\n${input.text}${input.error ? '\n' + input.error : ''}`; }
    if (collection === 'conversation') { const message = validate(ConversationSchema, value); return `${message.scope === 'session' ? `Session ${message.sessionId}${message.receiptId ? ` · input ${message.receiptId}` : ''}` : `Project history · ${message.historyReason}`}\n${message.role}\n${message.text}`; }
    if (collection === 'slices') { const slice = validate(StateSchema.properties.slices.items, value); return `${slice.id}\n${sliceReport(slice)}`; }
    return JSON.stringify(value);
  }
  private jsonPayload(reference: PayloadReference): unknown {
    if (reference.encoding !== 'json') throw new Error('Stored record bodies must use JSON encoding.');
    const value: unknown = JSON.parse(this.readPayload(reference)); return value;
  }
  /** Page cold decisions, Pi session paths and receipt edits without hydrating the whole chain. */
  readMetadataPage(query = '', page = 0): string {
    if (!Number.isInteger(page) || page < 0 || page > 1000) throw new Error('History page must be an integer from 0 to 1000.');
    this.assertIntegrity(); const rows: string[] = []; let skipped = 0, reference = this.latestIndex?.metadataHead;
    while (reference && rows.length < 40) {
      const block = validate(MetadataBlockSchema, this.jsonPayload(reference));
      for (const entry of [...block.entries].reverse()) {
        const text = JSON.stringify(entry); if (!text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        if (skipped++ < page * 40) continue; rows.push(text); if (rows.length === 40) break;
      }
      reference = block.previous;
    }
    return `Metadata history · latest page ${page} · ${rows.length} records · /history metadata page:N <search>\n\n` + (rows.reverse().join('\n\n') || 'No matching records.');
  }
  /** A snapshot hydration cache is accepted only when every scalar/record matches its index. */
  private hydrateIndex(value: unknown, hydration?: PayloadReference): ProjectState {
    const index = validate(StoredIndexSchema, value);
    if (hydration) {
      const cached = validate(StateSchema, this.jsonPayload(hydration));
      if (JSON.stringify(this.indexFor(cached, false)) !== JSON.stringify(index)) throw new StateIntegrityError('Snapshot hydration cache disagrees with its stored index.');
      return cached;
    }
    const decode = (collection: IndexCollection): unknown[] => index[collection].map(reference => this.jsonPayload(reference.body));
    const state = validate(StateSchema, { version: index.version, id: index.id, workspace: index.workspace, revision: index.revision,
      mode: index.mode, preference: index.preference, remainingSlices: index.remainingSlices,
      ...(index.runLimit !== undefined ? { runLimit: index.runLimit } : {}), currentSessionId: index.currentSessionId,
      intent: validate(IntentSchema, this.jsonPayload(index.intent)), ownership: index.ownership, sessions: index.sessions,
      ...(index.usage ? { usage: index.usage } : {}), ...(index.metadataHead ? { metadataHead: index.metadataHead } : {}),
      ...(Object.values(index.archives).some(boundary => boundary.count) ? { archives: index.archives } : {}),
      inputs: decode('inputs'), conversation: decode('conversation'), slices: decode('slices'), workEvents: decode('workEvents'),
      verificationEvidence: decode('verificationEvidence'), history: decode('history'), discoveries: decode('discoveries'),
      ...(index.hasBuilderMessages ? { builderMessages: decode('builderMessages') } : {}) });
    if (JSON.stringify(this.indexFor(state, false)) !== JSON.stringify(index)) throw new StateIntegrityError('Stored record identities disagree with their decoded bodies.');
    return state;
  }
  private seedRecordCache(state: ProjectState, index: StoredIndex): void {
    const entries: { key: string; value: unknown; reference: RecordReference }[] = [{ key: 'scalar\0intent', value: state.intent, reference: { id: 'intent', body: index.intent } }];
    for (const collection of INDEX_COLLECTIONS) {
      const records = this.records(state, collection);
      index[collection].forEach((reference, position) => entries.push({ key: `${collection}\0${reference.id}`, value: records[position], reference }));
    }
    const stats = this.paths.files(entries.map(entry => this.payloadName(entry.reference.body)));
    this.recordCache.clear(); this.recordCacheBytes = 0;
    for (const entry of entries) {
      const text = JSON.stringify(entry.value); if (text === undefined) throw new StateIntegrityError('Snapshot record is missing.');
      const stat = stats.get(this.payloadName(entry.reference.body)); if (!stat) throw new StateIntegrityError('Stored body is missing.');
      const bytes = Buffer.byteLength(text, 'utf8');
      if (bytes <= STORAGE_LIMITS.recordCacheBytes && this.recordCacheBytes + bytes <= STORAGE_LIMITS.recordCacheBytes && this.recordCache.size < STORAGE_LIMITS.recordCacheEntries) {
        this.recordCache.set(entry.key, { text, reference: entry.reference, bytes, stamp: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` }); this.recordCacheBytes += bytes;
      }
    }
  }
  private applyHydration(state: ProjectState, previous: StoredIndex, next: StoredIndex, delta: Extract<JournalEnvelope, { kind: 'delta' }>): ProjectState {
    const { intent, archives, hasBuilderMessages, ...fields } = delta.fields;
    const candidate: Record<string, unknown> = { ...state, ...fields };
    for (const field of delta.unsetFields ?? []) delete candidate[field];
    if (intent) candidate.intent = validate(IntentSchema, this.jsonPayload(intent));
    if (archives) {
      if (Object.values(archives).some(boundary => boundary.count)) candidate.archives = archives; else delete candidate.archives;
    }
    for (const collection of INDEX_COLLECTIONS) {
      if (!delta.arrays[collection]) continue;
      const oldRecords = this.records(state, collection);
      const old = new Map(previous[collection].map((reference, position) => [reference.id, { reference, value: oldRecords[position] }]));
      candidate[collection] = next[collection].map(reference => {
        const cached = old.get(reference.id);
        return cached && JSON.stringify(cached.reference) === JSON.stringify(reference) ? cached.value : this.jsonPayload(reference.body);
      });
    }
    if (!next.hasBuilderMessages) delete candidate.builderMessages;
    return validate(StateSchema, candidate);
  }
  /** Backward metadata replay stops at the newest snapshot, without reading old journal segments. */
  private indexRecords(): JournalEnvelope[] {
    const fd = this.open('journal.jsonl', 'r');
    try {
      let offset = fstatSync(fd).size, buffer = Buffer.alloc(0), skippedTail = false;
      const reverse: JournalEnvelope[] = [];
      const accept = (line: Buffer): boolean => {
        const record = validate(JournalEnvelopeSchema, JSON.parse(line.toString('utf8'))); reverse.push(record);
        return record.kind === 'snapshot';
      };
      while (offset > 0) {
        const length = Math.min(offset, 65536); offset -= length; const chunk = Buffer.alloc(length);
        readSync(fd, chunk, 0, length, offset); buffer = Buffer.concat([chunk, buffer]);
        if (!skippedTail) { const end = buffer.lastIndexOf(10); if (end < 0) continue; buffer = buffer.subarray(0, end); skippedTail = true; }
        let separator: number;
        while ((separator = buffer.lastIndexOf(10)) >= 0) {
          const line = buffer.subarray(separator + 1); buffer = buffer.subarray(0, separator);
          if (line.length && accept(line)) return reverse.reverse();
        }
      }
      if (buffer.length) accept(buffer);
      return reverse.reverse();
    } finally { closeSync(fd); }
  }
  private loadIndexed(last: unknown, checkpoint: unknown, expectedWorkspace: string): ProjectState {
    let base: Extract<JournalEnvelope, { kind: 'snapshot' }> | undefined;
    if (checkpoint && typeof checkpoint === 'object' && 'format' in checkpoint) {
      const parsed = validate(JournalEnvelopeSchema, checkpoint); if (parsed.kind !== 'snapshot') throw new Error('Checkpoint must contain a snapshot.'); base = parsed;
    }
    const indexedJournal = last && typeof last === 'object' && 'format' in last;
    const records = indexedJournal ? this.indexRecords() : [];
    const first = records.find(record => record.kind === 'snapshot');
    if (first?.kind === 'snapshot') {
      if (base && base.index.id !== first.index.id) throw new Error('Checkpoint belongs to a different project; inspect saved state before recovery.');
      if (!base || first.sequence > base.sequence) base = first;
    }
    if (!base) throw new Error('Index journal has no complete snapshot; refusing to overwrite it.');
    let index = base.index, sequence = base.sequence, state = this.hydrateIndex(index, base.hydration);
    for (const record of records) {
      if (record.sequence <= sequence) continue;
      if (record.kind !== 'delta') throw new Error('Unexpected journal snapshot sequence.');
      const next = applyIndexDelta(index, record, sequence); state = this.applyHydration(state, index, next, record); index = next; sequence = record.sequence;
    }
    if (index.workspace !== resolve(expectedWorkspace)) throw new Error('Workspace moved; use an explicit backed-up Store.relocate(previousWorkspace) operation.');
    if (checkpoint && typeof checkpoint === 'object' && !('format' in checkpoint)) {
      const old = savedState(checkpoint);
      if (old.id !== state.id) throw new Error('Checkpoint belongs to a different project; inspect saved state before recovery.');
      if (old.revision > state.revision) throw new Error('Legacy checkpoint is newer than the index; inspect before recovery.');
    }
    if (!indexedJournal && last) {
      const old = savedState(last);
      if (old.id !== state.id) throw new Error('Journal belongs to a different project.');
      if (old.revision > state.revision) throw new Error('Legacy journal is newer than the index; inspect before recovery.');
    }
    this.latestIndex = index; this.journalSequence = sequence; this.seedRecordCache(state, index); this.remember();
    for (const collection of Object.keys(index.archives)) {
      if (collection === 'inputs' || collection === 'conversation' || collection === 'slices' || collection === 'workEvents' || collection === 'verificationEvidence'
        || collection === 'history' || collection === 'discoveries' || collection === 'builderMessages' || collection === 'checkAttempts') this.archiveHash(collection, index.archives[collection]);
    }
    if (existsSync(this.path('journal.jsonl'))) this.lastRecord(this.path('journal.jsonl'));
    this.remember(); return state;
  }
  /** Hash and exact byte size are verified on every hydration, before JSON/image decoding. */
  readPayload(value: unknown): string {
    const reference = validate(PayloadReferenceSchema, value), name = this.payloadName(reference);
    const text = this.read(name), bytes = Buffer.from(text, 'utf8');
    if (bytes.length !== reference.bytes || createHash('sha256').update(bytes).digest('hex') !== reference.sha256) {
      throw new StateIntegrityError(`Payload hash/size mismatch: ${reference.sha256}. Inspect storage before retrying.`);
    }
    this.rememberPayload(reference); return text;
  }
  /** Reference conversion does not apply new-send policy to legacy bytes. */
  referenceImages(images: InputReceipt['attachments']) {
    return images.map(image => {
      validate(AttachmentSchema, image);
      if (typeof image.data !== 'string') return validate(ImageReferenceSchema, image);
      const reference = validate(ImageReferenceSchema, { type: 'image', mimeType: image.mimeType,
        blob: this.putPayload(JSON.stringify(image.data), 'json'), decodedBytes: imageBytes(image.data),
        ...(image.draftMarker ? { draftMarker: image.draftMarker } : {}) });
      const verified = this.verifiedInline.get(image);
      if (verified?.data === image.data && verified.mime === image.mimeType) this.rememberImage(reference.blob, verified.mime, verified.bytes);
      return reference;
    });
  }
  private rememberImage(reference: PayloadReference, mime: string, bytes: number): void {
    const stamp = this.stamp(this.payloadName(reference)); if (!stamp) throw new StateIntegrityError('Validated image disappeared.');
    this.imageSignatures.delete(reference.sha256); this.imageSignatures.set(reference.sha256, { stamp, mime, bytes, encodedBytes: reference.bytes });
    if (this.imageSignatures.size > 256) { const first = this.imageSignatures.keys().next().value; if (first) this.imageSignatures.delete(first); }
  }
  /** Explicit hydration only at transport/inspection boundaries; not during ordinary rendering. */
  images(images: InputReceipt['attachments']): InlineAttachment[] {
    return images.map(image => {
      validate(AttachmentSchema, image);
      const data = typeof image.data === 'string' ? image.data : validate(PayloadStringSchema, JSON.parse(this.readPayload(image.blob)));
      // Strip draft-only metadata before calling public Pi APIs.
      return validate(InlineAttachmentSchema, { type: 'image', mimeType: image.mimeType, data });
    });
  }
  /** A caller cannot forge a blob reference to evade the new image limits or signatures. */
  validateNewImages(value: unknown): void {
    const images = validate(ImagesSchema, value);
    let total = 0;
    for (const image of images) {
      const size = typeof image.data === 'string' ? imageBytes(image.data) : image.decodedBytes;
      if (size > IMAGE_LIMITS.each || (image.blob && (image.blob.encoding !== 'json' || image.blob.bytes > 20971522))) throw new Error('Each image is limited to 15 MiB; legacy payloads remain readable.');
      if (typeof image.data === 'string') {
        const cached = this.verifiedInline.get(image);
        if (!cached || cached.data !== image.data || cached.mime !== image.mimeType) {
          validateImages([image]); this.verifiedInline.set(image, { data: image.data, mime: image.mimeType, bytes: size });
        }
      } else {
        const cached = this.imageSignatures.get(image.blob.sha256), stamp = this.stamp(this.payloadName(image.blob));
        if (cached && cached.stamp === stamp) {
          if (cached.mime !== image.mimeType || cached.bytes !== image.decodedBytes || cached.encodedBytes !== image.blob.bytes) throw new Error('Image reference MIME/size metadata does not match its verified payload.');
        } else {
          const decoded = this.images([image])[0]; if (!decoded) throw new Error('Image data is missing.');
          validateImages([decoded]); const actualSize = imageBytes(decoded.data);
          if (actualSize !== image.decodedBytes) throw new Error('Image reference size metadata does not match its payload.');
          this.rememberImage(image.blob, decoded.mimeType, actualSize);
        }
      }
      total += size; if (total > IMAGE_LIMITS.total) throw new Error('Images total more than 30 MiB; remove or resize them before sending.');
    }
  }
  lock(): void {
    this.assertIntegrity(); const path = this.path('lock');
    if (existsSync(path)) {
      const identity = this.stamp('lock'), pid = Number(this.read('lock'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid workspace lock; inspect .fade/lock.');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false;
      }
      if (alive) throw new Error(`Workspace is already open (process ${pid}).`);
      if (this.stamp('lock') !== identity) throw new StateIntegrityError('Workspace lock changed during stale-lock recovery.');
      unlinkSync(this.path('lock'));
    }
    const fd = this.open('lock', 'wx');
    try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); this.paths.opened('lock', fd); }
    catch (error) {
      try { this.paths.opened('lock', fd); unlinkSync(this.path('lock')); } catch { /* Preserve replacements for inspection. */ }
      throw error;
    }
    finally { closeSync(fd); }
    this.lockOwned = true; this.lockIdentity = this.stamp('lock');
  }
  close(): void {
    this.flushTerminal();
    this.flushEvents();
    if (this.lockOwned) {
      this.lockOwned = false;
      try {
        if (this.stamp('lock') !== this.lockIdentity) throw new StateIntegrityError('Workspace lock was replaced; refusing to remove another lock.');
        unlinkSync(this.path('lock'));
      } catch (error) { this.diagnostic(error); }
    }
  }
  loadTerminal(sessionId = 'welcome'): TerminalState | undefined {
    const name = `terminal-${createHash('sha256').update(sessionId).digest('hex')}.json`;
    if (!existsSync(this.path(name))) return undefined;
    const value: unknown = JSON.parse(this.read(name));
    return value && typeof value === 'object' && 'version' in value ? validate(StoredTerminalSchema, value).state : validate(TerminalStateSchema, value);
  }
  saveTerminal(state: TerminalState): void {
    validate(TerminalStateSchema, state);
    const name = `terminal-${createHash('sha256').update(state.sessionId).digest('hex')}.json`;
    const stored = validate(StoredTerminalSchema, { version: 2, state: { ...state,
      ...(state.builderAttachments ? { builderAttachments: this.referenceImages(state.builderAttachments) } : {}),
      ...(state.companionAttachments ? { companionAttachments: this.referenceImages(state.companionAttachments) } : {}) } });
    if (existsSync(this.path(name))) {
      const old: unknown = JSON.parse(this.read(name));
      if (old && typeof old === 'object' && 'version' in old) validate(StoredTerminalSchema, old);
      else { validate(TerminalStateSchema, old); const stem = name.replace(/\.json$/, '-v1-backup'); if (!existsSync(this.path(`${stem}.json`))) this.backup(name, stem, 'json'); }
    }
    this.atomic(name, JSON.stringify(stored));
  }
  /** Fixed oldest-edit deadline: later typing replaces metadata without postponing the flush. */
  queueTerminal(state: TerminalState, onError?: (error: unknown) => void): void {
    validate(TerminalStateSchema, state);
    this.drafts.set(state.sessionId, { state: { ...state, ...(state.builderAttachments ? { builderAttachments: state.builderAttachments.map(image => ({ ...image })) } : {}),
      ...(state.companionAttachments ? { companionAttachments: state.companionAttachments.map(image => ({ ...image })) } : {}) }, ...(onError ? { onError } : {}) });
    if (!this.draftTimer) {
      this.draftTimer = setTimeout(() => { this.draftTimer = undefined; this.flushTerminal(); }, DRAFT_SAVE_DELAY);
      this.draftTimer.unref();
    }
  }
  /** Submission/navigation/shutdown boundaries flush drafts; failure never claims durable acceptance. */
  flushTerminal(sessionId?: string): void {
    const pending = sessionId ? [...this.drafts].filter(([id]) => id === sessionId) : [...this.drafts];
    for (const [id, draft] of pending) {
      this.drafts.delete(id);
      try { this.saveTerminal(draft.state); } catch (error) { this.diagnostic(error); try { draft.onError?.(error); } catch (observerError) { this.diagnostic(observerError); } }
    }
    if (!this.drafts.size && this.draftTimer) { clearTimeout(this.draftTimer); this.draftTimer = undefined; }
  }
  load(): ProjectState | undefined {
    return this.loadAtWorkspace(this.workspace);
  }
  private loadAtWorkspace(expectedWorkspace: string): ProjectState | undefined {
    // An explicit unlocked recovery may re-establish a crash fixture; active owners never bypass integrity checks.
    if (this.lockOwned) this.assertIntegrity();
    else { this.archiveHashes.clear(); this.recordCache.clear(); this.recordCacheBytes = 0; }
    const journal = this.path('journal.jsonl');
    const checkpoint = this.path('checkpoint.json');
    if (!existsSync(journal) && !existsSync(checkpoint)) return undefined;
    const last = existsSync(journal) ? this.lastRecord(journal, false) : undefined;
    if (!last && !existsSync(checkpoint)) throw new Error('Journal has no complete state; refusing to overwrite it.');
    const journalValue: unknown = last ? JSON.parse(last) : undefined;
    const checkpointValue: unknown = existsSync(checkpoint) ? JSON.parse(this.read('checkpoint.json')) : undefined;
    if ((journalValue && typeof journalValue === 'object' && 'format' in journalValue)
      || (checkpointValue && typeof checkpointValue === 'object' && 'format' in checkpointValue)) return this.loadIndexed(journalValue, checkpointValue, expectedWorkspace);
    this.latestIndex = undefined; this.journalSequence = 0;
    let saved = savedState(JSON.parse(last ?? this.read('checkpoint.json')));
    if (existsSync(checkpoint)) {
      const snapshot = savedState(JSON.parse(this.read('checkpoint.json')));
      if (snapshot.id !== saved.id) throw new Error('Checkpoint belongs to a different project; inspect saved state before recovery.');
      if (snapshot.revision > saved.revision) saved = snapshot;
    }
    if (resolve(saved.workspace) !== resolve(expectedWorkspace)) throw new Error('Workspace moved; use an explicit backed-up Store.relocate(previousWorkspace) operation.');
    this.remember();
    if (saved.version !== 5) {
      // Back up every authoritative source before repair, append or checkpoint.
      for (const [source, extension] of [['journal', 'jsonl'], ['checkpoint', 'json']] as const) {
        const path = this.path(`${source}.${extension}`);
        if (!existsSync(path)) continue;
        this.backup(`${source}.${extension}`, `${source}-v${saved.version}-backup`, extension);
      }
    }
    if (existsSync(journal)) this.lastRecord(journal);
    this.remember();
    const state = saved.version === 5 ? saved : migrateConversation(saved);
    if (saved.version !== 5 && expectedWorkspace === this.workspace) this.save(state);
    return state;
  }
  private backup(source: string, stem: string, extension: string): void {
    const base = `${stem}.${extension}`, name = existsSync(this.path(base)) ? `${stem}-${randomUUID()}.${extension}` : base;
    // Copy from checked descriptors, never follow a source swapped after path validation.
    const input = this.open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const output = this.open(name, 'wx');
      try {
        const buffer = Buffer.alloc(65536); let count: number;
        while ((count = readSync(input, buffer, 0, buffer.length, null)) > 0) {
          let written = 0;
          while (written < count) {
            const size = writeSync(output, buffer, written, count - written);
            if (size === 0) throw new Error('Backup write made no progress.');
            written += size;
          }
        }
        this.paths.opened(source, input); this.paths.opened(name, output); fsyncSync(output);
      } finally { closeSync(output); }
    } finally { closeSync(input); }
  }
  /** Explicit human recovery API: byte backups precede path changes; never replay uncertain work. */
  relocate(previousWorkspace: string): ProjectState {
    if (!this.lockOwned) throw new Error('Relocation requires the destination workspace lock.');
    if (resolve(previousWorkspace) === resolve(this.workspace)) throw new Error('Relocation needs a different previous workspace.');
    this.assertIntegrity();
    for (const [source, extension] of [['journal', 'jsonl'], ['checkpoint', 'json']] as const) {
      if (existsSync(this.path(`${source}.${extension}`))) this.backup(`${source}.${extension}`, `${source}-relocation-backup-${randomUUID()}`, extension);
    }
    const saved = this.loadAtWorkspace(previousWorkspace); if (!saved) throw new Error('No saved project to relocate.');
    if (!Number.isSafeInteger(saved.revision + 1)) throw new Error('Relocation revision exceeds safe integer range.');
    const state = validate(StateSchema, { ...saved, workspace: this.workspace, revision: saved.revision + 1, mode: 'paused',
      sessions: { builders: [] }, ownership: { owner: null, operation: null, transfer: null, interrupted: true },
      slices: saved.slices.map(slice => ({ ...slice, status: slice.status === 'running' ? 'interrupted' : slice.status,
        checks: slice.checks?.map(check => check.status === 'running' ? { ...check, status: 'not_run' } : check) })),
      inputs: saved.inputs.map(input => ['accepted', 'queued', 'processing'].includes(input.status) ? { ...input, status: 'interrupted',
        error: 'Workspace relocated; delivery is uncertain. Inspect before explicitly retrying.' } : input) });
    this.save(state); return state;
  }
  save(state: ProjectState): void {
    validate(StateSchema, state);
    this.assertIntegrity();
    this.flushEvents();
    for (const input of state.inputs) input.attachments = this.referenceImages(input.attachments);
    for (const event of state.workEvents) this.compactWorkEvent(event);
    for (const evidence of state.verificationEvidence) {
      if (!evidence.commandHash && ['bash', 'powershell'].includes(evidence.toolName)) {
        const input: unknown = evidence.inputRef ? this.jsonPayload(evidence.inputRef) : evidence.input;
        const args = input && typeof input === 'object' && 'args' in input && input.args && typeof input.args === 'object' ? input.args : undefined;
        if (args && 'command' in args && typeof args.command === 'string') evidence.commandHash = createHash('sha256').update(args.command.trim(), 'utf8').digest('hex');
      }
      if (!evidence.inputRef) { evidence.inputRef = this.putPayload(JSON.stringify(evidence.input), 'json'); evidence.input = operationSummary(evidence.input); }
      if (!evidence.resultRef) { evidence.resultRef = this.putPayload(JSON.stringify(evidence.result), 'json'); evidence.result = operationSummary(evidence.result); }
    }
    this.verifyRecordCache();
    const candidate = this.workingSet(state), index = this.indexFor(candidate), sequence = this.journalSequence + 1;
    const envelope = this.latestIndex ? indexDelta(this.latestIndex, index, this.journalSequence)
      : validate(JournalEnvelopeSchema, { format: 'fade-index-1', kind: 'snapshot', sequence, index, hydration: this.putPayload(JSON.stringify(candidate), 'json') });
    const fd = this.open('journal.jsonl', constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try { appendFileSync(fd, JSON.stringify(envelope) + '\n'); this.paths.opened('journal.jsonl', fd); fsyncSync(fd); }
    finally { closeSync(fd); }
    this.tracked.set('journal.jsonl', this.stamp('journal.jsonl'));
    this.latestIndex = index; this.journalSequence = sequence;
    candidate.slices = candidate.slices.map(slice => {
      const original = state.slices.find(old => old.id === slice.id); if (!original) return slice;
      Object.assign(original, slice); return original;
    });
    Object.assign(state, candidate);
    // Once fsync succeeds, acknowledgement is authoritative. Mirrors/renderers cannot revoke it.
    try {
      this.atomic('state.json', JSON.stringify(state, null, 2));
      this.atomic('intent.json', JSON.stringify(state.intent, null, 2));
      this.atomic('intent.md', renderIntent(state));
      if (++this.saves % 64 === 0) this.checkpoint(state);
    } catch (error) { if (error instanceof StateIntegrityError) this.integrityError = error; this.diagnostic(error); }
    for (const observer of this.observers) { try { observer(); } catch (error) { this.diagnostic(error); } }
  }
  /** Archive full provenance only after a durable recovery checkpoint exists. */
  checkpoint(state: ProjectState): void {
    validate(StateSchema, state); this.assertIntegrity();
    const index = this.indexFor(state), sequence = this.latestIndex && JSON.stringify(index) === JSON.stringify(this.latestIndex) ? this.journalSequence : this.journalSequence + 1;
    const snapshot = validate(JournalEnvelopeSchema, { format: 'fade-index-1', kind: 'snapshot', sequence, index, hydration: this.putPayload(JSON.stringify(state), 'json') });
    this.atomic('checkpoint.json', JSON.stringify(snapshot)); this.latestIndex = index; this.journalSequence = sequence;
    const journal = this.path('journal.jsonl');
    if (existsSync(journal)) { renameSync(this.path('journal.jsonl'), this.path(`journal-${state.revision}-${randomUUID()}.jsonl`)); this.tracked.set('journal.jsonl', undefined); }
    this.atomic('journal.jsonl', JSON.stringify(snapshot) + '\n');
  }
  /** Backward chunk reads depend on the last state size, not total journal history. */
  private lastRecord(path: string, repair = true): string | undefined {
    const name = relative(this.directory, path), fd = this.open(name, repair ? 'r+' : 'r');
    try {
      const size = fstatSync(fd).size; let offset = size; let tail = Buffer.alloc(0);
      let end = -1;
      while (offset > 0) {
        const length = Math.min(offset, 65536); offset -= length;
        const chunk = Buffer.alloc(length); readSync(fd, chunk, 0, length, offset); tail = Buffer.concat([chunk, tail]);
        if (end < 0) end = tail.lastIndexOf(10); else end += length;
        const start = end > 0 ? tail.lastIndexOf(10, end - 1) : -1;
        if (end >= 0 && (start >= 0 || offset === 0)) {
          if (repair && offset + end + 1 < size) {
            this.atomic(`interrupted-${randomUUID()}.txt`, tail.subarray(end + 1));
            this.paths.opened(name, fd);
            ftruncateSync(fd, offset + end + 1); fsyncSync(fd);
          }
          return tail.subarray(start + 1, end).toString('utf8');
        }
      }
      if (repair && tail.length) { this.atomic(`interrupted-${randomUUID()}.txt`, tail); this.paths.opened(name, fd); ftruncateSync(fd, 0); fsyncSync(fd); }
      return undefined;
    } finally { closeSync(fd); }
  }
  compactWorkEvent(event: WorkEvent, reference?: PayloadReference): void {
    if (event.payloadRef || event.payload === undefined) return;
    const value = event.payload, args = value && typeof value === 'object' && 'args' in value && value.args && typeof value.args === 'object' ? value.args : undefined;
    if (args && 'command' in args && typeof args.command === 'string') event.commandHash = createHash('sha256').update(args.command.trim(), 'utf8').digest('hex');
    event.payloadRef = reference ?? this.putPayload(JSON.stringify(value), 'json'); event.payload = operationSummary(value);
  }
  event(event: unknown): PayloadReference | undefined {
    const value = event && typeof event === 'object' && 'event' in event ? event.event : event;
    if (value && typeof value === 'object' && 'type' in value && ['tool_execution_update', 'tool_update'].includes(String(value.type))) {
      const key = `${event && typeof event === 'object' && 'event' in event ? 'raw' : 'typed'}:` + ('toolCallId' in value ? String(value.toolCallId) : 'operationId' in value ? String(value.operationId) : 'update');
      const text = JSON.stringify(event), bytes = Buffer.byteLength(text, 'utf8'), old = this.pendingEvents.get(key);
      if (old) this.pendingEventBytes -= Buffer.byteLength(old, 'utf8'); this.pendingEvents.delete(key);
      if (bytes <= 8 * 1024 * 1024) { this.pendingEvents.set(key, text); this.pendingEventBytes += bytes; }
      while (this.pendingEvents.size > 32 || this.pendingEventBytes > 8 * 1024 * 1024) {
        const first = this.pendingEvents.entries().next().value; if (!first) break;
        this.pendingEvents.delete(first[0]); this.pendingEventBytes -= Buffer.byteLength(first[1], 'utf8');
      }
      if (!this.eventTimer) { this.eventTimer = setTimeout(() => { this.eventTimer = undefined; try { this.flushEvents(); } catch (error) { this.diagnostic(error); for (const observer of this.storageObservers) { try { observer(error); } catch (observerError) { this.diagnostic(observerError); } } } }, DRAFT_SAVE_DELAY); this.eventTimer.unref(); }
      return undefined;
    }
    this.flushEvents(); return this.writeEvent(event);
  }
  flushEvents(): void {
    if (this.eventTimer) { clearTimeout(this.eventTimer); this.eventTimer = undefined; }
    for (const [key, text] of this.pendingEvents) { this.writeEvent(JSON.parse(text)); this.pendingEvents.delete(key); this.pendingEventBytes -= Buffer.byteLength(text, 'utf8'); }
  }
  private writeEvent(event: unknown): PayloadReference {
    const value = event && typeof event === 'object' && 'event' in event ? event.event : event;
    const reference = this.putPayload(JSON.stringify(value), 'json');
    this.assertIntegrity(); const fd = this.open('builder-events.jsonl', constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0));
    try { appendFileSync(fd, JSON.stringify({ timestamp: Date.now(), event: operationSummary(event), payloadRef: reference }) + '\n'); this.paths.opened('builder-events.jsonl', fd); fsyncSync(fd); } finally { closeSync(fd); }
    this.tracked.set('builder-events.jsonl', this.stamp('builder-events.jsonl'));
    return reference;
  }
  prepareIntentEdit(state: ProjectState): string {
    this.atomic('intent-edit.json', JSON.stringify(state.intent, null, 2)); return this.path('intent-edit.json');
  }
  readIntent() { return validate(IntentSchema, JSON.parse(this.read('intent-edit.json'))); }
  private changesFile(sliceId: string, suffix: string): string {
    if (!/^[0-9a-f-]{36}$/i.test(sliceId)) throw new Error('Invalid slice identity.');
    return `changes-${sliceId}-${suffix}`;
  }
  async beginChanges(sliceId: string): Promise<void> { this.atomic(this.changesFile(sliceId, 'before.json'), JSON.stringify(await captureWorkspace(this.workspace))); }
  async finishChanges(sliceId: string): Promise<void> {
    const before = validate(WorkspaceSnapshotSchema, JSON.parse(this.read(this.changesFile(sliceId, 'before.json'))));
    this.atomic(this.changesFile(sliceId, 'diff.txt'), renderChanges(before, await captureWorkspace(this.workspace)));
  }
  readChanges(sliceId: string): string {
    const name = this.changesFile(sliceId, 'diff.txt');
    return existsSync(this.path(name)) ? this.read(name) : 'Changes are not captured yet. Interrupted or legacy slices may lack a complete baseline; attribution is unknown.';
  }
  /** Stream history instead of loading the file; keep only a bounded page window. */
  async readLogPage(query = '', page = 0): Promise<string> {
    if (!Number.isInteger(page) || page < 0 || page > 10) throw new Error('Log page must be between 0 and 10; use a search to narrow older history.');
    const path = this.path('builder-events.jsonl'); if (!existsSync(path)) return 'No Builder events yet.';
    const fd = this.open('builder-events.jsonl', 'r');
    const lines = createInterface({ input: createReadStream(path, { fd, encoding: 'utf8', autoClose: true }), crlfDelay: Infinity });
    const matches: string[] = []; let total = 0; const window = (page + 1) * 40;
    try {
      for await (const line of lines) {
        const record: unknown = JSON.parse(line);
        const raw = record && typeof record === 'object' && 'payloadRef' in record ? this.jsonPayload(validate(PayloadReferenceSchema, record.payloadRef)) : undefined;
        const entry = executionLog(raw === undefined ? line : JSON.stringify({ event: { event: raw } }), 1, 65536);
        if (entry === 'No Builder tool events yet.' || !entry.toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
        total++; matches.push(entry); if (matches.length > window) matches.shift();
      }
    } finally { lines.close(); }
    const entries = matches.slice(0, Math.max(0, matches.length - page * 40));
    return `Execution history · latest page ${page} · ${total} matches · /log page:N <search> searches all retained history\n\n${entries.join('\n\n') || 'No matching events.'}`;
  }
  private atomic(name: string, text: string | Uint8Array): void {
    this.assertIntegrity();
    const target = this.path(name), tempName = `${name}.${randomUUID()}.tmp`;
    const fd = this.open(tempName, 'wx');
    let identity: string | undefined;
    try { writeFileSync(fd, text); this.paths.opened(tempName, fd); fsyncSync(fd); identity = this.stamp(tempName); }
    finally { closeSync(fd); }
    try {
      this.path(name);
      if (this.stamp(tempName) !== identity) throw new StateIntegrityError('Atomic state temporary file was replaced.');
      renameSync(this.path(tempName), target);
      if (this.tracked.has(name)) this.tracked.set(name, this.stamp(name));
    } catch (error) {
      // Never remove a replacement planted by another process.
      if (identity && this.stamp(tempName) === identity) unlinkSync(this.path(tempName));
      throw error;
    }
  }
}
export function renderIntent(state: ProjectState): string {
  const entries = (kind: string) => state.intent.decisions.filter(d => d.kind === kind && d.status !== 'superseded')
    .map(d => `- ${d.text} [${d.status}; ${d.key}]\n  From you: “${d.quote}”`).join('\n') || '- None yet.';
  return `# Living Intent\n\n${state.intent.vision}\n\n## Design principles\n${entries('principle')}
\n## Established decisions\n${entries('decision')}\n\n## Implementation constraints\n${entries('constraint')}
\n## Explorations (not requirements)\n${entries('tentative')}\n\n## Open questions\n${state.intent.openQuestions.map(q => '- ' + q).join('\n') || '- None.'}
\n## Present and future\n${state.slices.map(s => `- ${s.plan.title}: ${s.status} · acceptance ${acceptanceStatus(s)}\n  ${s.plan.goal}\n  Requirements: ${s.plan.requirements.join('; ')}\n  Decisions: ${s.plan.decisionKeys.join(', ')}\n  Depends on: ${s.plan.dependencies.join(', ')}\n  Assumptions: ${s.plan.assumptions.join('; ')}`).join('\n')}
\n## Discoveries\n${state.discoveries.map(d => '- ' + d.summary).join('\n') || '- None.'}\n`;
}
