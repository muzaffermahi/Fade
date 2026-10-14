// LM Studio transport for Fade's Coordinator loop, powered by qwen3.5-2b.
// Implements the same Agents interface as PiAgents but routes every call through
// a local LM Studio OpenAI-compatible endpoint instead of Pi's native sessions.
import { Type } from 'typebox';
import { BuilderSchema, CompanionSchema, validate, type CompanionReply, type ProjectState, type Slice, type BuilderResult } from './contracts.js';
import type { Agents } from './coordinator.js';
import { BUILDER_PROMPT, COMPANION_PROMPT } from './prompts.js';

const LMSTUDIO_URL = process.env.LMSTUDIO_URL || 'http://localhost:1234/v1/chat/completions';
const QWEN_MODEL = process.env.QWEN_MODEL || 'qwen3.5-2b';

interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string; }

/** Extract the first balanced-brace object from an arbitrary model reply,
 *  stripping markdown fences and any prose that precedes it. */
function extractJSON(s: string): unknown {
  const trimmed = s.trim();
  // Drop a leading ```json fence if present so brace scanning starts at {.
  const fenceIdx = trimmed.indexOf('```');
  let src = trimmed;
  if (fenceIdx >= 0) {
    const afterFence = trimmed.slice(fenceIdx).indexOf('{');
    if (afterFence > 0) src = trimmed.slice(fenceIdx + afterFence);
  }
  let depth = 0, start = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { if (start < 0) start = i; depth++; }
    else if (ch === '}' && depth > 0) { depth--; if (depth === 0) return JSON.parse(src.slice(start, i + 1)); }
  }
  throw new Error('No balanced object found');
}

/** Coerce a model reply to the exact CompanionReply/BuilderResult contract. */
function coerce(isBuilder: true, raw: string): BuilderResult;
function coerce(isBuilder: false, raw: string): CompanionReply;
function coerce(isBuilder: boolean, raw: string): BuilderResult | CompanionReply {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  let obj: Record<string, unknown>;
  try { obj = validate(Type.Record(Type.String(), Type.Unknown()), extractJSON(cleaned)); }
  catch (e) { throw new Error(`Model did not return parseable JSON: ${cleaned.slice(0, 200)}`); }
  if (isBuilder) {
    obj.status = obj.status === 'completed' ? 'completed' : 'blocked';
    obj.summary = typeof obj.summary === 'string' && obj.summary.length ? obj.summary : 'No summary provided.';
    obj.verification = Array.isArray(obj.verification) ? obj.verification : [];
    obj.discoveries = Array.isArray(obj.discoveries) ? obj.discoveries : [];
  } else {
    if (typeof obj.reply !== 'string') obj.reply = '';
    if (!Array.isArray(obj.evidence)) obj.evidence = [];
    if (!Array.isArray(obj.openQuestions)) obj.openQuestions = [];
    if (obj.next === undefined) obj.next = null;
  }
  return isBuilder ? validate(BuilderSchema, obj) : validate(CompanionSchema, obj);
}

async function chat(messages: ChatMessage[], maxTokens = 1200): Promise<string> {
  const res = await fetch(LMSTUDIO_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: QWEN_MODEL, messages, temperature: 0.7, max_tokens: maxTokens }),
  });
  if (!res.ok) throw new Error(`LM Studio ${res.status}`);
  const json = validate(Type.Object({ choices: Type.Array(Type.Object({
    message: Type.Object({ content: Type.String() })
  }), { minItems: 1 }) }), await res.json());
  const content = json.choices[0]?.message.content;
  if (!content?.trim()) throw new Error('LM Studio returned no text response.');
  return content;
}

/** Drives Fade's Coordinator with qwen3.5-2b as both Companion and Builder. */
export class LMStudioAgents implements Agents {
  private companionHistory: ChatMessage[] = [];
  private builderHistory: ChatMessage[] = [];
  constructor(private readonly workspace: string) { this.workspace = workspace; }

  async converse(_state: ProjectState, message: string): Promise<CompanionReply> {
    const history = this.companionHistory;
    if (history.length === 0) { history.push({ role: 'system', content: COMPANION_PROMPT }); }
    history.push({ role: 'user', content: message });
    const reply = await chat(history, 1200);
    history.push({ role: 'assistant', content: reply });
    if (history.length > 6) { history.splice(0, history.length - 4); }
    return coerce(false, reply);
  }

  async build(slice: Slice): Promise<BuilderResult> {
    const brief = JSON.stringify({ slice: slice.plan, snapshot: slice.snapshot, builderNotes: [] }, null, 2);
    const history = this.builderHistory;
    if (history.length === 0) { history.push({ role: 'system', content: BUILDER_PROMPT }); }
    history.push({ role: 'user', content: brief });
    const reply = await chat(history, 1400);
    history.push({ role: 'assistant', content: reply });
    if (history.length > 6) { history.splice(0, history.length - 4); }
    return coerce(true, reply);
  }

  close(): void { /* stateless per call; nothing to release */ }
}
