import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SettingsManager,
  SessionManager, getAgentDir, type AgentSession } from '@earendil-works/pi-coding-agent';
import { BuilderSchema, CompanionSchema, parseResponse, type ProjectState, type Slice, type BuilderMessage } from './contracts.js';
import type { TSchema, Static } from 'typebox';
import type { Agents } from './coordinator.js';
import { Store } from './store.js';
import { BUILDER_PROMPT, COMPANION_PROMPT } from './prompts.js';
import { piBuiltins } from './pi-resources.js';

export interface PiOptions {
  builderModel?: string; companionModel?: string;
  companionThinkingLevel?: NonNullable<Parameters<typeof createAgentSession>[0]>['thinkingLevel'];
}
/** Shared model selection for the native UI and the two actual execution roles. */
export function resolvePiModel(registry: ModelRuntime, selector: string, sessionId: string) {
  const separator = selector.indexOf('/');
  if (separator <= 0 || separator === selector.length - 1) throw new Error('Use model format provider/model-id.');
  const provider = selector.slice(0, separator), id = selector.slice(separator + 1);
  const model = registry.getModel(provider, id);
  if (!model) throw new Error(`Unknown Pi model: ${selector}. Configure it in Pi's models.json or select a listed model.`);
  return model.provider === 'opencode-go' ? { ...model, headers: {
    ...model.headers, 'x-opencode-session': sessionId
  } } : model;
}
/** Real Pi sessions with separate contexts, tools, and persisted session references. */
export class PiAgents implements Agents {
  private readonly active = new Set<AgentSession>();
  private readonly runtime = ModelRuntime.create();
  private builderSession: AgentSession | undefined;
  constructor(private readonly store: Store, private readonly state: ProjectState, private readonly options: PiOptions = {},
    private readonly nativeConversation?: Agents['converse']) {}
  async build(slice: Slice, signal: AbortSignal, emit: (event: unknown) => void) {
    const actual = await this.session('builder');
    this.builderSession = actual;
    const off = actual.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'user') {
        const content = JSON.stringify(event.message.content);
        for (const note of this.state.builderMessages ?? []) if (note.sliceId === slice.id && note.status !== 'received'
          && content.includes(note.id)) emit({ type: 'builder_note_received', id: note.id });
      }
      if (event.type === 'tool_execution_start') emit(`Pi is using ${event.toolName}`);
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'message_end') emit(event);
    });
    try {
      const notes = (this.state.builderMessages ?? []).filter(note => note.sliceId === slice.id && note.status === 'pending');
      return await this.structured(actual, JSON.stringify({ slice: slice.plan, snapshot: slice.snapshot, builderNotes: notes }), BuilderSchema, signal);
    } finally { this.builderSession = undefined; off(); actual.dispose(); this.active.delete(actual); }
  }
  /** Pi's normal steering queue delivers notes at its next tool/assistant boundary. */
  async steerBuilder(message: BuilderMessage): Promise<'queued' | 'pending'> {
    const actual = this.builderSession;
    if (!actual?.isStreaming) return 'pending';
    const disposition = await actual.steer(`Human note to the Builder (${message.id}):\n${message.text}\nRespond in your report. Keep the supplied slice scope; scope changes use Fade's explicit redirect.`, undefined, { source: 'extension' });
    return disposition === 'queued' ? 'queued' : 'pending';
  }
  async converse(state: ProjectState, message: string, signal: AbortSignal) {
    if (this.nativeConversation) return this.nativeConversation(state, message, signal);
    const session = await this.session('companion');
    try {
      const context = { trigger: message ? 'human-conversation' : 'builder-discovery-reconciliation',
        instruction: message ? 'Engage with the current human message.' : 'Reconcile held future briefs against actual discoveries and existing settled intent. There is no new human message. Return evidence=[]; do not invent decisions. Revise a brief if it can proceed safely, otherwise explain the remaining uncertainty and keep it unready.',
        preference: state.preference, intent: state.intent,
        slices: state.slices.filter(s => s.status !== 'cancelled').slice(-8),
        discoveries: state.discoveries.slice(-10), conversation: state.conversation.slice(-12),
        currentHumanMessage: message };
      return await this.structured(session, JSON.stringify(context), CompanionSchema, signal);
    } finally { session.dispose(); this.active.delete(session); }
  }
  close(): void { for (const s of this.active) s.dispose(); this.active.clear(); }
  private async structured<S extends TSchema>(session: AgentSession, input: string, schema: S, signal: AbortSignal): Promise<Static<S>> {
    const raw = await this.prompt(session, input, signal);
    try { return parseResponse(schema, raw); } catch (error) {
      // One formatting repair, never a repeated implementation run or silent coercion.
      session.setActiveToolsByName([]);
      const reason = error instanceof Error ? error.message : String(error);
      const repaired = await this.prompt(session, `Your previous response was rejected: ${reason}. Repair its JSON format exactly to the following schema. No tools are available. Preserve what actually happened; do not invent work, quotes, or verification. Evidence quotes must come verbatim from currentHumanMessage in the previous context. Omit unsupported evidence. Return only JSON. Schema: ${JSON.stringify(schema)}`, signal);
      return parseResponse(schema, repaired);
    }
  }
  async models(): Promise<string[]> {
    return (await (await this.runtime).getAvailable()).map(m => `${m.provider}/${m.id}`);
  }
  private async session(role: 'builder' | 'companion') {
    const configured = SettingsManager.create(this.store.workspace, getAgentDir());
    const runtime = await this.runtime;
    // Use Pi's complete tool/resource loading, adding only the role's instructions.
    const services = await createAgentSessionServices({ cwd: this.store.workspace, agentDir: getAgentDir(),
      modelRuntime: runtime, settingsManager: configured, resourceLoaderOptions: {
        extensionFactories: await piBuiltins(), appendSystemPrompt: [role === 'builder' ? BUILDER_PROMPT : COMPANION_PROMPT] } });
    const selector = role === 'builder' ? this.options.builderModel : this.options.companionModel;
    const sessionsDir = join(this.store.directory, 'sessions', role); await mkdir(sessionsDir, { recursive: true });
    // Full history stays in Pi files and journal. Each turn has a concise explicit context, preventing stale hidden briefs.
    const manager = SessionManager.create(this.store.workspace, sessionsDir);
    const { session } = await createAgentSessionFromServices({ services,
      ...(selector ? { model: resolvePiModel(runtime, selector, manager.getSessionId()) } : {}),
      ...(role === 'companion' && this.options.companionThinkingLevel ? { thinkingLevel: this.options.companionThinkingLevel } : {}),
      sessionManager: manager });
    await session.bindExtensions({});
    if (session.model?.provider === 'opencode-go') await session.setModel(
      resolvePiModel(runtime, `${session.model.provider}/${session.model.id}`, manager.getSessionId()));
    this.active.add(session);
    const file = manager.getSessionFile();
    if (file) {
      if (role === 'companion') this.state.sessions.companion = file;
      else this.state.sessions.builders.push(file);
      this.store.save(this.state);
    }
    return session;
  }
  private async prompt(session: AgentSession, text: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('Agent cancelled');
    const abort = () => { void session.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10 * 60 * 1000);
    try {
      await session.prompt(text, { expandPromptTemplates: false });
      const last = session.messages.filter(m => m.role === 'assistant').at(-1);
      if (!last || last.role !== 'assistant') throw new Error('Pi returned no assistant response.');
      if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(last.errorMessage || `Pi ${last.stopReason}`);
      const reply = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!reply.trim()) throw new Error('Pi returned an empty response.');
      return reply;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
}
