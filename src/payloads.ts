import { Type } from 'typebox';
import { createHash } from 'node:crypto';
import { InlineAttachmentSchema, IndexFieldsSchema, StoredIndexSchema, JournalEnvelopeSchema, validate,
  type ArchiveManifest, type StoredIndex, type RecordReference, type JournalEnvelope, type InlineAttachment } from './contracts.js';

/** Limits apply to new input; byte-preserving legacy migration never uses this validator. */
export const IMAGE_LIMITS = { count: 20, each: 15 * 1024 * 1024, total: 30 * 1024 * 1024 };
export const SEND_CHARACTERS = 20000;
export const DRAFT_SAVE_DELAY = 150;
export const STORAGE_LIMITS = { receipts: 128, conversation: 128, work: 128, verification: 128, slices: 32, history: 16,
  discoveries: 32, notes: 32, attempts: 64, pendingInputs: 200, supersededDecisions: 32, builderSessions: 32, inputEdits: 16,
  recordCacheBytes: 8 * 1024 * 1024, recordCacheEntries: 1024 };
export const INDEX_COLLECTIONS = ['inputs', 'conversation', 'slices', 'workEvents', 'verificationEvidence', 'history', 'discoveries', 'builderMessages'] as const;
export type IndexCollection = typeof INDEX_COLLECTIONS[number];
type Delta = Extract<JournalEnvelope, { kind: 'delta' }>;
type ArrayPatch = NonNullable<Delta['arrays']['inputs']>;
const EMPTY_HASH = createHash('sha256').update('').digest('hex');
export function emptyArchives(): ArchiveManifest {
  const boundary = () => ({ bytes: 0, count: 0, sha256: EMPTY_HASH });
  return { inputs: boundary(), conversation: boundary(), slices: boundary(), workEvents: boundary(), verificationEvidence: boundary(),
    history: boundary(), discoveries: boundary(), builderMessages: boundary(), checkAttempts: boundary() };
}
function scalarIndex(index: StoredIndex) {
  const { inputs, conversation, slices, workEvents, verificationEvidence, history, discoveries, builderMessages, ...fields } = index;
  return fields;
}
function arrayPatch(previous: RecordReference[], next: RecordReference[]): ArrayPatch | undefined {
  const old = new Map(previous.map(entry => [entry.id, entry])), current = new Map(next.map(entry => [entry.id, entry]));
  if (old.size !== previous.length || current.size !== next.length) throw new Error('Stored record identities must be unique.');
  const upsert = next.filter(entry => JSON.stringify(old.get(entry.id)) !== JSON.stringify(entry));
  const remove = previous.filter(entry => !current.has(entry.id)).map(entry => entry.id);
  const oldOrder = previous.map(entry => entry.id), order = next.map(entry => entry.id);
  const reordered = JSON.stringify(oldOrder) !== JSON.stringify(order);
  return upsert.length || remove.length || reordered ? { upsert, remove, ...(reordered ? { order } : {}) } : undefined;
}
/** Only changed record references/scalars enter a journal delta; old payload bytes are never copied. */
export function indexDelta(previous: StoredIndex, next: StoredIndex, baseSequence: number): Delta {
  validate(StoredIndexSchema, previous); validate(StoredIndexSchema, next);
  if (previous.id !== next.id) throw new Error('Project identity cannot change inside an index journal.');
  const old = scalarIndex(previous), current = scalarIndex(next), changed: Record<string, unknown> = {};
  for (const key of ['version', 'id', 'workspace', 'revision', 'mode', 'preference', 'remainingSlices', 'runLimit', 'currentSessionId', 'intent', 'ownership', 'usage', 'sessions', 'metadataHead', 'archives', 'hasBuilderMessages'] as const) {
    if (current[key] !== undefined && JSON.stringify(old[key]) !== JSON.stringify(current[key])) changed[key] = current[key];
  }
  const unsetFields = (['usage', 'runLimit'] as const).filter(key => key in old && !(key in current));
  const arrays: Delta['arrays'] = {};
  for (const collection of INDEX_COLLECTIONS) { const patch = arrayPatch(previous[collection], next[collection]); if (patch) arrays[collection] = patch; }
  const validated = validate(JournalEnvelopeSchema, { format: 'fade-index-1', kind: 'delta', sequence: baseSequence + 1,
    baseSequence, fields: validate(IndexFieldsSchema, changed), arrays, ...(unsetFields.length ? { unsetFields } : {}) });
  if (validated.kind !== 'delta') throw new Error('Expected index delta.'); return validated;
}
/** Pure strict replay; unknown/duplicate IDs and incomplete reorderings are conflicts, not coercions. */
export function applyIndexDelta(previous: StoredIndex, value: unknown, sequence: number): StoredIndex {
  const delta = validate(JournalEnvelopeSchema, value);
  if (delta.kind !== 'delta' || delta.baseSequence !== sequence || delta.sequence !== sequence + 1) throw new Error('Index journal sequence conflict.');
  if (delta.fields.id && delta.fields.id !== previous.id) throw new Error('Index delta belongs to a different project.');
  const candidate = { ...previous, ...delta.fields };
  for (const field of delta.unsetFields ?? []) delete candidate[field];
  for (const collection of INDEX_COLLECTIONS) {
    const patch = delta.arrays[collection]; if (!patch) continue;
    const records = new Map(previous[collection].map(entry => [entry.id, entry]));
    if (records.size !== previous[collection].length || new Set(patch.upsert.map(entry => entry.id)).size !== patch.upsert.length) throw new Error('Duplicate stored record identity.');
    for (const id of patch.remove) { if (!records.delete(id)) throw new Error('Index delta removes an unknown record.'); }
    for (const entry of patch.upsert) records.set(entry.id, entry);
    const order = patch.order ?? [...records.keys()];
    if (order.length !== records.size || new Set(order).size !== order.length) throw new Error('Index delta has an incomplete or duplicate order.');
    candidate[collection] = order.map(id => { const entry = records.get(id); if (!entry) throw new Error('Index order contains an unknown record.'); return entry; });
  }
  return validate(StoredIndexSchema, candidate);
}
const NewImagesSchema = Type.Array(InlineAttachmentSchema, { maxItems: IMAGE_LIMITS.count });
/** Match JSON Schema maxLength: Unicode code points, including astral emoji. */
export function textCharacters(text: string): number { let count = 0; for (const _character of text) count++; return count; }
/** Size metadata is cheap enough for every render; do not decode image buffers to draw a tray. */
export function imageBytes(data: string): number {
  return Math.max(0, Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0));
}

/** Identify supported encoded image signatures without guessing a MIME type. */
export function imageMime(bytes: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' {
  const starts = (signature: readonly number[]) => signature.every((value, index) => bytes[index] === value);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255])) return 'image/jpeg';
  if (bytes.length >= 16 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF'
    && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(Buffer.from(bytes.subarray(12, 16)).toString('ascii'))) return 'image/webp';
  throw new Error('Unsupported image signature. Use PNG, JPEG or WebP.');
}

/** External images cross the schema and byte/signature budget before any receipt is accepted. */
export function validateImages(value: unknown): InlineAttachment[] {
  const images = validate(NewImagesSchema, value);
  let total = 0;
  for (const image of images) {
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.toString('base64') !== image.data || !bytes.length) throw new Error('Image data must be nonempty canonical base64.');
    if (bytes.length > IMAGE_LIMITS.each) throw new Error('Each image is limited to 15 MiB. Remove or resize it before sending.');
    total += bytes.length;
    if (total > IMAGE_LIMITS.total) throw new Error('Images total more than 30 MiB. Remove or resize them before sending.');
    if (imageMime(bytes) !== image.mimeType) throw new Error('Image MIME type does not match its PNG/JPEG/WebP signature.');
  }
  return images;
}

/** A send limit does not truncate or discard the editable draft. */
export function validateSendText(text: string): void {
  const count = textCharacters(text);
  if (count > SEND_CHARACTERS) throw new Error(`Draft has ${count.toLocaleString()} characters; send at most 20,000. Shorten or split it; your draft is retained.`);
}

/** A bounded preview preserves check-critical fields; original JSON remains in its private payload. */
export function operationSummary(value: unknown): unknown {
  let nodes = 0;
  const priority = ['type', 'toolName', 'toolCallId', 'isError', 'args', 'command', 'result', 'details', 'exitCode', 'path', 'content', 'partialResult'];
  const visit = (current: unknown, depth: number): unknown => {
    if (++nodes > 512 || depth > 6) return '[more retained in private payload]';
    if (typeof current === 'string') return current.slice(0, 2000);
    if (!current || typeof current !== 'object') return current;
    if (Array.isArray(current)) return current.slice(0, 8).map(item => visit(item, depth + 1));
    const result: Record<string, unknown> = {};
    const keys = Object.keys(current).filter(key => !['__proto__', 'constructor', 'prototype'].includes(key));
    keys.sort((a, b) => (priority.includes(a) ? priority.indexOf(a) : 99) - (priority.includes(b) ? priority.indexOf(b) : 99));
    for (const key of keys.slice(0, 30)) {
      const field: unknown = Reflect.get(current, key);
      if (key === 'command' && typeof field === 'string') {
        if (field.length <= 20000) result.command = field; else result.commandPreview = field.slice(0, 2000);
      } else result[key] = visit(field, depth + 1);
    }
    return result;
  };
  return visit(value, 0);
}
