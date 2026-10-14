import { Type, type Static, type TSchema } from 'typebox';
import { Ajv } from 'ajv';

const text = Type.String({ minLength: 1, maxLength: 20000 });
const strings = Type.Array(text, { maxItems: 50 });
const object = { additionalProperties: false };
const Kind = Type.Union([Type.Literal('decision'), Type.Literal('principle'), Type.Literal('constraint'), Type.Literal('tentative')]);
const BuildStatus = Type.Union([Type.Literal('completed'), Type.Literal('blocked')]);
const Mode = Type.Union([Type.Literal('running'), Type.Literal('paused'), Type.Literal('stopped')]);
const Preference = Type.Union([Type.Literal('design'), Type.Literal('technical')]);
const SliceStatus = Type.Union([Type.Literal('draft'), Type.Literal('ready'), Type.Literal('running'),
  Type.Literal('completed'), Type.Literal('blocked'), Type.Literal('cancelled'), Type.Literal('interrupted'), Type.Literal('reconcile')]);
const Evidence = Type.Object({ key: text, text, quote: text,
  kind: Kind,
  replaces: Type.Optional(text) }, object);
const LegacyPlanSchema = Type.Object({ title: text, goal: text,
  requirements: strings, decisionKeys: strings, dependencies: strings,
  assumptions: strings, acceptanceChecks: Type.Optional(strings), ready: Type.Boolean() }, object);
/** An exact stock-tool command or an explicitly human-inspected criterion. Neither authorizes coordinator execution. */
export const CheckDefinitionSchema = Type.Union([
  Type.Object({ kind: Type.Literal('executable'), criterion: text, command: text }, object),
  Type.Object({ kind: Type.Literal('manual'), criterion: text }, object),
]);
export const PlanSchema = Type.Object({ ...LegacyPlanSchema.properties,
  acceptanceChecks: Type.Optional(Type.Array(Type.Union([text, CheckDefinitionSchema]), { maxItems: 50 })) }, object);
/** A conversational reply and a conservative, evidence-backed intent delta. */
export const CompanionSchema = Type.Object({ reply: text, evidence: Type.Array(Evidence, { maxItems: 20 }),
  openQuestions: strings, next: Type.Union([PlanSchema, Type.Null()]) }, object);
/** Structured intent metadata, separate from Pi's natural streaming response. */
export const IntentUpdateSchema = Type.Omit(CompanionSchema, ['reply']);
export type IntentUpdate = Static<typeof IntentUpdateSchema>;
/** Claims made by Pi, retained as claims alongside its actual execution events. */
export const BuilderSchema = Type.Object({ status: BuildStatus, summary: text,
  verification: strings, discoveries: Type.Array(Type.Object({ summary: text, affects: strings }, object), { maxItems: 20 }) }, object);
const DecisionSchema = Type.Object({ id: text, key: text, text, quote: text,
  kind: Kind, sourceId: text,
  status: Type.Union([Type.Literal('active'), Type.Literal('superseded'), Type.Literal('conflict')]) }, object);
export const IntentSchema = Type.Object({ revision: Type.Integer({ minimum: 0 }), vision: text,
  decisions: Type.Array(DecisionSchema), openQuestions: strings }, object);
const SnapshotSchema = Type.Object({ intent: IntentSchema, requirements: strings, goal: text }, object);
/** Durable notes for the Builder; receipt means the note entered its Pi context. */
export const BuilderMessageSchema = Type.Object({ id: text, text, timestamp: Type.Integer(),
  sliceId: Type.Optional(text), status: Type.Union([Type.Literal('pending'), Type.Literal('queued'), Type.Literal('received')]) }, object);
export type BuilderMessage = Static<typeof BuilderMessageSchema>;
export const LegacyStateSchema = Type.Object({ version: Type.Literal(1), id: text, workspace: text,
  revision: Type.Integer({ minimum: 0 }), mode: Mode,
  preference: Preference, remainingSlices: Type.Integer({ minimum: 0, maximum: 20 }),
  intent: IntentSchema,
  slices: Type.Array(Type.Object({ id: text, plan: LegacyPlanSchema,
    status: SliceStatus,
    snapshot: Type.Optional(SnapshotSchema), result: Type.Optional(BuilderSchema) }, object)),
  conversation: Type.Array(Type.Object({ id: text, role: Type.Union([Type.Literal('human'), Type.Literal('companion')]), text,
    timestamp: Type.Integer(), applied: Type.Optional(Type.Boolean()) }, object)),
  builderMessages: Type.Optional(Type.Array(BuilderMessageSchema)),
  discoveries: Type.Array(Type.Object({ summary: text, affects: strings }, object)),
  history: Type.Array(Type.Object({ timestamp: Type.Integer(), reason: text, intent: IntentSchema }, object)),
  sessions: Type.Object({ companion: Type.Optional(text), builders: strings }, object)
}, object);
const RoleSchema = Type.Union([Type.Literal('companion'), Type.Literal('builder')]);
/** Server-defined recovery controls; model prose cannot create actions. */
export const RecoveryActionSchema = Type.Union([Type.Literal('inputs'), Type.Literal('retry-input'), Type.Literal('diagnostics'), Type.Literal('pause'), Type.Literal('rethink'), Type.Literal('intent'), Type.Literal('log'), Type.Literal('builder'), Type.Literal('pi'), Type.Literal('restart'), Type.Literal('edit-draft')]);
/** Transient activity, validated independently of durable project snapshots. */
export const ActivitySchema = Type.Object({ role: RoleSchema, sessionId: text, operationId: text,
  state: Type.Union([Type.Literal('ready'), Type.Literal('preparing'), Type.Literal('waiting_for_provider'), Type.Literal('streaming'), Type.Literal('inspecting'), Type.Literal('executing'), Type.Literal('checking'), Type.Literal('queued'), Type.Literal('cancelling'), Type.Literal('paused'), Type.Literal('blocked'), Type.Literal('failed'), Type.Literal('completed')]),
  phase: Type.String({ maxLength: 1000 }), startedAt: Type.Integer(), lastActivityAt: Type.Integer(),
  queueCount: Type.Integer({ minimum: 0 }), cancellationRequested: Type.Boolean(),
  tool: Type.Optional(text), target: Type.Optional(text), command: Type.Optional(text),
  error: Type.Optional(text), recovery: Type.Array(RecoveryActionSchema),
  usage: Type.Optional(Type.Object({ tokens: Type.Integer({ minimum: 0 }),
    contextUsed: Type.Optional(Type.Integer({ minimum: 0 })), contextWindow: Type.Optional(Type.Integer({ minimum: 1 })) }, object)) }, object);
export type RoleActivity = Static<typeof ActivitySchema>;
/** One typed error boundary shared by split, native and plain surfaces. */
export const NotificationSchema = Type.Object({ kind: Type.Union([Type.Literal('acceptance_rejected'), Type.Literal('accepted_not_delivered'), Type.Literal('uncertain_delivery'), Type.Literal('provider_failure'), Type.Literal('tool_failure'), Type.Literal('storage_failure'), Type.Literal('unsupported_capability'), Type.Literal('invalid_command'), Type.Literal('intent_conflict'), Type.Literal('verification_failure'), Type.Literal('result')]),
  role: RoleSchema, sessionId: text, operationId: text, receiptId: Type.Optional(text),
  timestamp: Type.Integer(), cause: Type.String({ minLength: 1, maxLength: 2000 }), actions: Type.Array(RecoveryActionSchema) }, object);
export type FadeNotification = Static<typeof NotificationSchema>;
const InputModeSchema = Type.Union([Type.Literal('steer'), Type.Literal('followUp')]);
/** Immutable protected payload identity; bytes describe encoded storage, never a caller-supplied path. */
export const PayloadReferenceSchema = Type.Object({ sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }),
  bytes: Type.Integer({ minimum: 0 }), encoding: Type.Union([Type.Literal('json'), Type.Literal('utf8'), Type.Literal('base64')]) }, object);
export type PayloadReference = Static<typeof PayloadReferenceSchema>;
/** Original inline shape is kept for byte-preserving v2/v3/v4 reads. */
const LegacyAttachmentSchema = Type.Object({ type: Type.Literal('image'), mimeType: text, data: Type.String({ minLength: 1, maxLength: 20000000 }) }, object);
const DraftImageMarker = Type.Optional(Type.String({ pattern: '^(\\[image:[0-9a-f-]{36}\\]|\\[image [0-9]{1,2}\\])$', maxLength: 44 }));
/** New image bytes are validated before storage; draft markers never enter Pi image metadata. */
export const InlineAttachmentSchema = Type.Object({ type: Type.Literal('image'), mimeType: text,
  data: Type.String({ minLength: 1, maxLength: 20971520 }),
  draftMarker: DraftImageMarker, blob: Type.Optional(Type.Never()), decodedBytes: Type.Optional(Type.Never()) }, object);
/** Reference metadata stays small; hydration verifies actual hash, bytes and encoded image data. */
export const ImageReferenceSchema = Type.Object({ type: Type.Literal('image'), mimeType: text,
  blob: PayloadReferenceSchema, decodedBytes: Type.Integer({ minimum: 0 }), draftMarker: DraftImageMarker, data: Type.Optional(Type.Never()) }, object);
export const AttachmentSchema = Type.Union([InlineAttachmentSchema, ImageReferenceSchema]);
export type InlineAttachment = Static<typeof InlineAttachmentSchema>;
/** Processing receipts are durable; acceptance and model consumption are distinct. */
export const InputReceiptSchema = Type.Object({ id: text, sessionId: text, role: RoleSchema,
  mode: InputModeSchema, text, attachments: Type.Array(AttachmentSchema, { maxItems: 20 }),
  status: Type.Union([Type.Literal('accepted'), Type.Literal('queued'), Type.Literal('processing'), Type.Literal('processed'), Type.Literal('interrupted'), Type.Literal('failed'), Type.Literal('cancelled')]),
  timestamp: Type.Integer(), updatedAt: Type.Integer(), attempts: Type.Integer({ minimum: 0 }),
  error: Type.Optional(text), edits: Type.Array(Type.Object({ text, timestamp: Type.Integer() }, object)) }, object);
export type InputReceipt = Static<typeof InputReceiptSchema>;
const LegacyInputReceiptSchema = Type.Object({ ...Type.Omit(InputReceiptSchema, ['attachments']).properties,
  attachments: Type.Array(LegacyAttachmentSchema, { maxItems: 20 }) }, object);
/** Honest work phases; no percentage is inferred from model prose. */
export const WorkPhaseSchema = Type.Union([Type.Literal('inspecting'), Type.Literal('editing'), Type.Literal('checking'), Type.Literal('blocked'), Type.Literal('stopping'), Type.Literal('completed')]);
/** Persisted, sequenced adapter events consumed by projections. Payloads remain observed data. */
export const WorkEventSchema = Type.Object({ sliceId: text, sequence: Type.Integer({ minimum: 1 }),
  timestamp: Type.Integer(), phase: WorkPhaseSchema,
  type: Type.Union([Type.Literal('phase'), Type.Literal('tool_start'), Type.Literal('tool_update'), Type.Literal('tool_end'), Type.Literal('outcome')]),
  toolName: Type.Optional(text), operationId: Type.Optional(text), payload: Type.Optional(Type.Unknown()),
  isError: Type.Optional(Type.Boolean()), payloadRef: Type.Optional(PayloadReferenceSchema), commandHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) }, object);
export type WorkEvent = Static<typeof WorkEventSchema>;
/** Coordinator ownership, including in-progress transfer and interruption. */
export const OwnershipSchema = Type.Object({ owner: Type.Union([RoleSchema, Type.Null()]),
  operation: Type.Union([text, Type.Null()]), transfer: Type.Union([RoleSchema, Type.Null()]), interrupted: Type.Boolean() }, object);
/** Verification records contain actual tool results, separately from Builder claims. */
export const VerificationEvidenceSchema = Type.Object({ sliceId: text, sequence: Type.Integer({ minimum: 1 }),
  operationId: text, toolName: text, timestamp: Type.Integer(), isError: Type.Boolean(),
  input: Type.Unknown(), result: Type.Unknown(), inputRef: Type.Optional(PayloadReferenceSchema), resultRef: Type.Optional(PayloadReferenceSchema),
  commandHash: Type.Optional(Type.String({ pattern: '^[a-f0-9]{64}$' })) }, object);
const RoleUsageSchema = Type.Object({ tokens: Type.Integer({ minimum: 0 }), cost: Type.Null() }, object);
/** v2 adds routing and typed coordination without dropping any v1 provenance. */
export const V2StateSchema = Type.Object({ ...Type.Omit(LegacyStateSchema, ['version']).properties,
  conversation: Type.Array(Type.Object({ id: text, role: Type.Union([Type.Literal('human'), Type.Literal('companion')]), text,
    timestamp: Type.Integer(), applied: Type.Optional(Type.Boolean()), targetRole: Type.Optional(RoleSchema) }, object)),
  version: Type.Literal(2), currentSessionId: text,
  runLimit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  sessions: Type.Object({ companion: Type.Optional(text), builders: Type.Array(text) }, object),
  inputs: Type.Array(LegacyInputReceiptSchema), workEvents: Type.Array(Type.Omit(WorkEventSchema, ['payloadRef', 'commandHash'])),
  ownership: OwnershipSchema, verificationEvidence: Type.Array(Type.Omit(VerificationEvidenceSchema, ['inputRef', 'resultRef', 'commandHash'])),
  usage: Type.Optional(Type.Object({ companion: Type.Optional(RoleUsageSchema), builder: Type.Optional(RoleUsageSchema) }, object)),
}, object);
const ConversationFields = { id: text, role: Type.Union([Type.Literal('human'), Type.Literal('companion')]), text,
  timestamp: Type.Integer(), applied: Type.Optional(Type.Boolean()), targetRole: Type.Optional(RoleSchema) };
/** A native/session association needs provenance; ambiguous legacy records remain labelled history. */
export const ConversationSchema = Type.Union([
  Type.Object({ ...ConversationFields, scope: Type.Literal('session'), sessionId: text, receiptId: Type.Optional(text) }, object),
  Type.Object({ ...ConversationFields, scope: Type.Literal('project_history'), historyReason: text }, object),
]);
/** v3 separates session discussion from preserved workspace provenance. */
export const V3StateSchema = Type.Object({ ...Type.Omit(V2StateSchema, ['version', 'conversation']).properties,
  version: Type.Literal(3), conversation: Type.Array(ConversationSchema) }, object);
/** Durable attempts reference observed execution or an explicit human receipt, never a model verification claim. */
export const CheckAttemptSchema = Type.Union([
  Type.Object({ source: Type.Literal('execution'), sequence: Type.Integer({ minimum: 1 }), operationId: text, toolName: text,
    timestamp: Type.Integer(), status: Type.Union([Type.Literal('passed'), Type.Literal('failed')]), evidence: text }, object),
  Type.Object({ source: Type.Literal('human'), commandId: text, receiptId: text, timestamp: Type.Integer(),
    status: Type.Union([Type.Literal('passed'), Type.Literal('failed')]), evidence: text }, object),
]);
export const CheckStatusSchema = Type.Union([Type.Literal('not_run'), Type.Literal('running'), Type.Literal('passed'), Type.Literal('failed'), Type.Literal('needs_human_inspection')]);
/** Sequence boundary prevents historical evidence from verifying newly declared or rerun work. */
export const AcceptanceCheckSchema = Type.Object({ id: text, definition: CheckDefinitionSchema, status: CheckStatusSchema,
  afterSequence: Type.Integer({ minimum: 0 }), latestResult: Type.Optional(text), history: Type.Array(CheckAttemptSchema) }, object);
export type AcceptanceCheck = Static<typeof AcceptanceCheckSchema>;
export type CheckDefinition = Static<typeof CheckDefinitionSchema>;
/** Human-only boundary. Replayed IDs are idempotent only for the same decision. */
export const ManualCheckActionSchema = Type.Object({ commandId: text, expectedRevision: Type.Integer({ minimum: 0 }), sliceId: text, checkId: text,
  passed: Type.Boolean(), evidence: text }, object);
export const V4StateSchema = Type.Object({ ...Type.Omit(V3StateSchema, ['version', 'slices']).properties, version: Type.Literal(4),
  slices: Type.Array(Type.Object({ ...V3StateSchema.properties.slices.items.properties, plan: PlanSchema,
    checks: Type.Optional(Type.Array(AcceptanceCheckSchema, { maxItems: 50 })) }, object)) }, object);
const ArchiveBoundarySchema = Type.Object({ bytes: Type.Integer({ minimum: 0 }), count: Type.Integer({ minimum: 0 }),
  sha256: Type.String({ pattern: '^[a-f0-9]{64}$' }) }, object);
/** Only committed prefixes are queryable; orphan writes never become accepted history. */
export const ArchiveManifestSchema = Type.Object({ inputs: ArchiveBoundarySchema, conversation: ArchiveBoundarySchema,
  slices: ArchiveBoundarySchema, workEvents: ArchiveBoundarySchema, verificationEvidence: ArchiveBoundarySchema,
  history: ArchiveBoundarySchema, discoveries: ArchiveBoundarySchema, builderMessages: ArchiveBoundarySchema,
  checkAttempts: ArchiveBoundarySchema }, object);
export type ArchiveManifest = Static<typeof ArchiveManifestSchema>;
export type ArchiveCollection = keyof ArchiveManifest;
/** v5 moves image and cold payload data out of hot coordinator/draft indices. */
export const StateSchema = Type.Object({ ...Type.Omit(V4StateSchema, ['version', 'inputs']).properties,
  version: Type.Literal(5), inputs: Type.Array(InputReceiptSchema), archives: Type.Optional(ArchiveManifestSchema),
  metadataHead: Type.Optional(PayloadReferenceSchema),
  workEvents: Type.Array(WorkEventSchema), verificationEvidence: Type.Array(VerificationEvidenceSchema),
  slices: Type.Array(Type.Object({ ...V4StateSchema.properties.slices.items.properties,
    lastSequence: Type.Optional(Type.Integer({ minimum: 0 })) }, object)) }, object);
/** Cold metadata is linked only through an acknowledged index; blobs never authorize replay. */
export const MetadataEntrySchema = Type.Union([
  Type.Object({ kind: Type.Literal('decision'), decision: DecisionSchema }, object),
  Type.Object({ kind: Type.Literal('builderSession'), path: text }, object),
  Type.Object({ kind: Type.Literal('inputEdit'), receiptId: text, text, timestamp: Type.Integer() }, object),
]);
export const MetadataBlockSchema = Type.Object({ previous: Type.Optional(PayloadReferenceSchema),
  entries: Type.Array(MetadataEntrySchema, { minItems: 1, maxItems: 128 }) }, object);
export type MetadataEntry = Static<typeof MetadataEntrySchema>;
/** Encoded body references keep journal patches independent of large text or raw tool output. */
export const RecordReferenceSchema = Type.Object({ id: text, body: PayloadReferenceSchema, lookup: Type.Optional(text) }, object);
/** Archived human command IDs remain idempotent after the recent attempt window rotates. */
export const ArchivedCheckAttemptSchema = Type.Object({ sliceId: text, checkId: text, attempt: CheckAttemptSchema }, object);
export type RecordReference = Static<typeof RecordReferenceSchema>;
const RecordReferences = Type.Array(RecordReferenceSchema, { maxItems: 4096 });
const StoredScalars = Type.Omit(StateSchema, ['intent', 'inputs', 'conversation', 'slices', 'workEvents', 'verificationEvidence',
  'history', 'discoveries', 'builderMessages', 'archives']);
/** Internal persisted index is validated separately from hydrated runtime state. */
export const StoredIndexSchema = Type.Object({ ...StoredScalars.properties, intent: PayloadReferenceSchema,
  inputs: RecordReferences, conversation: RecordReferences, slices: RecordReferences, workEvents: RecordReferences,
  verificationEvidence: RecordReferences, history: RecordReferences, discoveries: RecordReferences, builderMessages: RecordReferences,
  hasBuilderMessages: Type.Boolean(), archives: ArchiveManifestSchema }, object);
export type StoredIndex = Static<typeof StoredIndexSchema>;
const ArrayPatchSchema = Type.Object({ upsert: RecordReferences, remove: Type.Array(text, { uniqueItems: true }), order: Type.Optional(Type.Array(text, { uniqueItems: true })) }, object);
export const IndexFieldsSchema = Type.Partial(Type.Omit(StoredIndexSchema, ['inputs', 'conversation', 'slices', 'workEvents',
  'verificationEvidence', 'history', 'discoveries', 'builderMessages']));
/** Storage sequence is distinct from domain revision; no partial or unordered delta is accepted. */
export const JournalEnvelopeSchema = Type.Union([
  Type.Object({ format: Type.Literal('fade-index-1'), kind: Type.Literal('snapshot'), sequence: Type.Integer({ minimum: 1 }), index: StoredIndexSchema,
    hydration: Type.Optional(PayloadReferenceSchema) }, object),
  Type.Object({ format: Type.Literal('fade-index-1'), kind: Type.Literal('delta'), sequence: Type.Integer({ minimum: 2 }),
    baseSequence: Type.Integer({ minimum: 1 }), fields: IndexFieldsSchema,
    unsetFields: Type.Optional(Type.Array(Type.Union([Type.Literal('usage'), Type.Literal('runLimit')]), { uniqueItems: true })), arrays: Type.Partial(Type.Object({
      inputs: ArrayPatchSchema, conversation: ArrayPatchSchema, slices: ArrayPatchSchema, workEvents: ArrayPatchSchema,
      verificationEvidence: ArrayPatchSchema, history: ArrayPatchSchema, discoveries: ArrayPatchSchema, builderMessages: ArrayPatchSchema }, object)) }, object),
]);
export type JournalEnvelope = Static<typeof JournalEnvelopeSchema>;
export type ConversationRecord = Static<typeof ConversationSchema>;
/** Trusted adapter observation, not a model-authored authorization or intent proposal. */
export const NativeReplySchema = Type.Object({ type: Type.Literal('fade_reply_observed'), id: text, sessionId: text,
  receiptId: Type.Optional(text), timestamp: Type.Integer(), text }, object);
/** Only proven session discussion enters normal transcript/provider history. */
export function sessionConversation(state: ProjectState, sessionId = state.currentSessionId): ConversationRecord[] {
  return state.conversation.filter(message => message.scope === 'session' && message.sessionId === sessionId);
}
export const RunLimitSchema = Type.Integer({ minimum: 1, maximum: 20 });
/** Session-local reading references restore a display page; they never authorize or replay inputs. */
const ReadingPositionSchema = Type.Object({ source: Type.String({ minLength: 1, maxLength: 4096 }),
  offset: Type.Integer({ minimum: 0, maximum: 200000 }), pageIds: Type.Array(Type.String({ minLength: 1, maxLength: 4096 }), { maxItems: 64, uniqueItems: true }) }, object);
/** Session-bound terminal drafts are never executable accepted input. */
export const TerminalStateSchema = Type.Object({ sessionId: text,
  mode: Type.Union([Type.Literal('builder'), Type.Literal('companion'), Type.Literal('fade')]), focus: RoleSchema,
  builderDraft: Type.String({ maxLength: 200000 }), companionDraft: Type.String({ maxLength: 200000 }),
  builderAttachments: Type.Optional(Type.Array(AttachmentSchema, { maxItems: 20 })), companionAttachments: Type.Optional(Type.Array(AttachmentSchema, { maxItems: 20 })),
  builderScroll: Type.Integer({ minimum: 0 }), companionScroll: Type.Integer({ minimum: 0 }),
  builderReading: Type.Optional(ReadingPositionSchema), companionReading: Type.Optional(ReadingPositionSchema) }, object);
export type TerminalState = Static<typeof TerminalStateSchema>;
/** Draft index version is independent of accepted-receipt durability. */
export const StoredTerminalSchema = Type.Object({ version: Type.Literal(2), state: Type.Object({
  ...Type.Omit(TerminalStateSchema, ['builderAttachments', 'companionAttachments']).properties,
  builderAttachments: Type.Optional(Type.Array(ImageReferenceSchema, { maxItems: 20 })),
  companionAttachments: Type.Optional(Type.Array(ImageReferenceSchema, { maxItems: 20 })) }, object) }, object);
export type Intent = Static<typeof IntentSchema>;
export type ProjectState = Static<typeof StateSchema>;
export type Slice = ProjectState['slices'][number];
export type CompanionReply = Static<typeof CompanionSchema>;
export type BuilderResult = Static<typeof BuilderSchema>;
export type Plan = Static<typeof PlanSchema>;
const ajv = new Ajv({ allErrors: true });
/** Reject invalid external values before they enter the coordinator. */
export function validate<S extends TSchema>(schema: S, data: unknown): Static<S> {
  const check = ajv.compile<Static<S>>(schema);
  if (!check(data)) throw new Error(`Invalid data: ${ajv.errorsText(check.errors)}`);
  return data;
}
export function parseResponse<S extends TSchema>(schema: S, raw: string): Static<S> {
  const clean = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return validate(schema, JSON.parse(clean));
}
