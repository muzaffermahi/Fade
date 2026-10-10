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
export const PlanSchema = Type.Object({ title: text, goal: text,
  requirements: strings, decisionKeys: strings, dependencies: strings,
  assumptions: strings, ready: Type.Boolean() }, object);
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
export const StateSchema = Type.Object({ version: Type.Literal(1), id: text, workspace: text,
  revision: Type.Integer({ minimum: 0 }), mode: Mode,
  preference: Preference, remainingSlices: Type.Integer({ minimum: 0, maximum: 20 }),
  intent: IntentSchema,
  slices: Type.Array(Type.Object({ id: text, plan: PlanSchema,
    status: SliceStatus,
    snapshot: Type.Optional(SnapshotSchema), result: Type.Optional(BuilderSchema) }, object)),
  conversation: Type.Array(Type.Object({ id: text, role: Type.Union([Type.Literal('human'), Type.Literal('companion')]), text,
    timestamp: Type.Integer(), applied: Type.Optional(Type.Boolean()) }, object)),
  builderMessages: Type.Optional(Type.Array(BuilderMessageSchema)),
  discoveries: Type.Array(Type.Object({ summary: text, affects: strings }, object)),
  history: Type.Array(Type.Object({ timestamp: Type.Integer(), reason: text, intent: IntentSchema }, object)),
  sessions: Type.Object({ companion: Type.Optional(text), builders: strings }, object)
}, object);
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
