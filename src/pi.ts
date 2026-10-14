import { createAgentSession, createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SettingsManager,
  SessionManager, getAgentDir, type AgentSession } from '@earendil-works/pi-coding-agent';
import { BuilderSchema, CompanionSchema, parseResponse, sessionConversation, type InlineAttachment, type ProjectState, type Slice, type BuilderMessage } from './contracts.js';
import type { TSchema, Static } from 'typebox';
import type { Agents } from './coordinator.js';
import { Store } from './store.js';
import { BUILDER_PROMPT, COMPANION_PROMPT } from './prompts.js';
import { piBuiltins } from './pi-resources.js';
import { sharedContext } from './shared-context.js';
import { ReceiptCorrelation } from './receipt-correlation.js';

export interface PiOptions {
  builderModel?: string; companionModel?: string;
  runLimit?: number;
  /** Positive provider-turn deadline; expiration interrupts without replay. Default: ten minutes. */
  providerTurnDeadlineMs?: number;
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
  private builderCorrelation: ReceiptCorrelation | undefined;
  private companionTokens: number | undefined;
  companionUsage(): number | undefined { return this.companionTokens; }
  constructor(private readonly store: Store, private readonly state: ProjectState, private readonly options: PiOptions = {},
    private readonly nativeConversation?: Agents['converse']) {}
  async build(slice: Slice, signal: AbortSignal, emit: (event: unknown) => void) {
    emit({ type: 'activity_prepare' });
    // Validate the complete initial image bundle before acquiring any session resources.
    const notes = (this.state.builderMessages ?? []).filter(note => note.sliceId === slice.id && note.status === 'pending');
    const sourceIds = new Set((slice.snapshot?.intent.decisions ?? []).filter(decision => slice.plan.decisionKeys.includes(decision.key) && decision.status === 'active').map(decision => decision.sourceId));
    for (const note of notes) sourceIds.add(note.id);
    const imageReferences = this.state.inputs.filter(input => sourceIds.has(input.id) && input.status !== 'cancelled').flatMap(input => input.attachments);
    this.store.validateNewImages(imageReferences); const images = this.store.images(imageReferences);
    await this.store.beginChanges(slice.id);
    if (signal.aborted) throw new Error('Builder interrupted before execution.');
    const actual = await this.session('builder');
    if (signal.aborted) { actual.dispose(); this.active.delete(actual); throw new Error('Builder interrupted during setup.'); }
    this.builderSession = actual;
    const correlation = new ReceiptCorrelation(actual.agent); this.builderCorrelation = correlation;
    const initialPrompt = JSON.stringify({ slice: slice.plan, snapshot: slice.snapshot, builderNotes: notes });
    let initialConsumed = false;
    const off = actual.subscribe(event => {
      if (event.type === 'message_end' && event.message.role === 'user') {
        const receipt = correlation.consumed(event.message);
        if (receipt && this.state.builderMessages?.some(note => note.id === receipt.id && note.sliceId === slice.id)) emit({ type: 'builder_note_received', id: receipt.id });
        // The initial brief is a coordinator-authored payload, consumed once before queued notes.
        const content = typeof event.message.content === 'string' ? event.message.content : event.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        if (!initialConsumed && content === initialPrompt) { initialConsumed = true; for (const note of notes) emit({ type: 'builder_note_received', id: note.id }); }
      }
      if (event.type === 'tool_execution_start') emit(`Pi is using ${event.toolName}`);
      if (['tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'message_end', 'message_update', 'turn_start', 'auto_retry_start', 'auto_retry_end', 'compaction_start', 'compaction_end'].includes(event.type)) emit(event);
      if (event.type === 'message_end' || event.type === 'compaction_end') {
        const usage = actual.getContextUsage();
        if (usage) emit({ type: 'role_context', tokens: actual.getSessionStats().tokens.total, contextWindow: usage.contextWindow, ...(usage.tokens !== null ? { contextUsed: usage.tokens } : {}) });
      }
    });
    try {
      emit({ type: 'activity_wait' });
      return await this.structured(actual, initialPrompt, BuilderSchema, signal, images, () => emit({ type: 'activity_cancel' }));
    } finally { emit({ type: 'role_usage', tokens: actual.getSessionStats().tokens.total }); this.builderSession = undefined; this.builderCorrelation = undefined; correlation.dispose(); off(); actual.dispose(); this.active.delete(actual); await this.store.finishChanges(slice.id); }
  }
  /** Pi's normal steering queue delivers notes at its next tool/assistant boundary. */
  async steerBuilder(message: BuilderMessage): Promise<'queued' | 'pending'> {
    const actual = this.builderSession;
    const correlation = this.builderCorrelation;
    if (!actual?.isStreaming || !correlation) return 'pending';
    const receipt = this.state.inputs.find(i => i.id === message.id);
    if (!receipt) throw new Error('Builder note has no durable receipt; delivery was rejected.');
    const text = `Human note to the Builder (${message.id}):\n${message.text}\nRespond in your report. Keep the supplied slice scope; scope changes use Fade's explicit redirect.`;
    const images = this.store.images(receipt.attachments);
    if (images.length && !actual.model?.input.includes('image')) throw new Error('The selected Builder model does not support images. Choose a vision model or remove the images.');
    const disposition = await correlation.dispatch(receipt, () => receipt.mode === 'followUp' ? actual.followUp(text, images, { source: 'extension' }) : actual.steer(text, images, { source: 'extension' }));
    return disposition === 'queued' ? 'queued' : 'pending';
  }
  /** Rebuild Fade's own native mailbox after an explicit queue edit/cancellation. */
  async refreshBuilderQueue(prepareOnly = false): Promise<void> {
    const actual = this.builderSession;
    if (!actual?.isStreaming) return;
    const current = this.state.inputs.filter(i => i.role === 'builder' && i.status === 'queued' && this.state.builderMessages?.some(note => note.id === i.id && this.state.slices.some(slice => slice.id === note.sliceId && slice.status === 'running')));
    const allNotes = this.state.builderMessages ?? [];
    if (!this.builderCorrelation?.allOwned(new Set(current.map(input => input.id)))) {
      throw new Error('Builder queue contains another extension\'s input. Wait for its delivery before editing; Pi does not expose its attachments for lossless restoration.');
    }
    if (prepareOnly) return;
    actual.clearQueue();
    for (const input of current) {
      const note = allNotes.find(n => n.id === input.id); if (note) await this.steerBuilder(note);
    }
  }
  async converse(state: ProjectState, message: string, signal: AbortSignal, event?: (value: unknown) => void, sourceId?: string) {
    if (this.nativeConversation) return this.nativeConversation(state, message, signal, event, sourceId);
    const session = await this.session('companion');
    const off = session.subscribe(value => event?.(value));
    try {
      const context = { trigger: message ? 'human-conversation' : 'builder-discovery-reconciliation',
        instruction: message ? 'Engage with the current human message.' : 'Reconcile held future briefs against actual discoveries and existing settled intent. There is no new human message. Return evidence=[]; do not invent decisions. Revise a brief if it can proceed safely, otherwise explain the remaining uncertainty and keep it unready.',
        preference: state.preference, intent: state.intent,
        slices: state.slices.filter(s => s.status !== 'cancelled').slice(-8),
        discoveries: state.discoveries.slice(-10), conversation: sessionConversation(state).slice(-12),
        currentHumanMessage: message };
      const input = state.inputs.find(input => input.id === sourceId);
      return await this.structured(session, JSON.stringify(context), CompanionSchema, signal, input ? this.store.images(input.attachments) : [], () => event?.({ type: 'activity_cancel' }));
    } finally { this.companionTokens = session.getSessionStats().tokens.total; off(); session.dispose(); this.active.delete(session); }
  }
  close(): void { for (const s of this.active) s.dispose(); this.active.clear(); }
  private async structured<S extends TSchema>(session: AgentSession, input: string, schema: S, signal: AbortSignal, images: InlineAttachment[] = [], onDeadline?: () => void): Promise<Static<S>> {
    const raw = await this.prompt(session, input, signal, images, onDeadline);
    try { return parseResponse(schema, raw); } catch (error) {
      // One formatting repair, never a repeated implementation run or silent coercion.
      session.setActiveToolsByName([]);
      const reason = error instanceof Error ? error.message : String(error);
      const repaired = await this.prompt(session, `Your previous response was rejected: ${reason}. Repair its JSON format exactly to the following schema. No tools are available. Preserve what actually happened; do not invent work, quotes, or verification. Evidence quotes must come verbatim from currentHumanMessage in the previous context. Omit unsupported evidence. Return only JSON. Schema: ${JSON.stringify(schema)}`, signal, [], onDeadline);
      return parseResponse(schema, repaired);
    }
  }
  async models(): Promise<string[]> {
    return (await (await this.runtime).getAvailable()).map(m => `${m.provider}/${m.id}`);
  }
  private async session(role: 'builder' | 'companion') {
    let activeSession: AgentSession | undefined;
    const configured = SettingsManager.create(this.store.workspace, getAgentDir());
    const runtime = await this.runtime;
    // Use Pi's complete tool/resource loading, adding only the role's instructions.
    const services = await createAgentSessionServices({ cwd: this.store.workspace, agentDir: getAgentDir(),
      modelRuntime: runtime, settingsManager: configured, resourceLoaderOptions: {
        extensionFactories: [...await piBuiltins(), { name: 'Fade shared context', factory: (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
          pi.on('before_agent_start', event => { event.systemPromptOptions.sections.fade_role = role === 'builder' ? BUILDER_PROMPT : COMPANION_PROMPT; });
          pi.on('context', event => {
            try { this.store.sessionDirectory(role); } catch (error) { void activeSession?.abort(); throw error; }
            return { messages: [...event.messages, { role: 'custom', customType: 'fade-shared-context', content: JSON.stringify(sharedContext(this.state, role)), display: false, timestamp: Date.now() }] };
          });
        } }, ...(role === 'companion' ? [{ name: 'Fade ownership', factory: (pi: import('@earendil-works/pi-coding-agent').ExtensionAPI) => {
          pi.on('context_with_system', event => ({ messages: event.messages.map(message => message.role === 'system' && message.toolsAdded
            ? { ...message, toolsAdded: message.toolsAdded.filter(tool => ['read', 'grep', 'find', 'ls'].includes(tool.name)
              ) } : message) }));
          pi.on('tool_call', event => {
            if (['read', 'grep', 'find', 'ls'].includes(event.toolName)) return;
            return { block: true, reason: 'The Builder owns implementation. Propose supported work in your structured reply; Companion inspection remains available.' };
          });
        } }] : [])], appendSystemPrompt: [role === 'builder' ? BUILDER_PROMPT : COMPANION_PROMPT] } });
    const selector = role === 'builder' ? this.options.builderModel : this.options.companionModel;
    const sessionsDir = this.store.sessionDirectory(role);
    // Full history stays in Pi files and journal. Each turn has a concise explicit context, preventing stale hidden briefs.
    const manager = SessionManager.create(this.store.workspace, sessionsDir);
    const { session } = await createAgentSessionFromServices({ services,
      ...(role === 'companion' ? { tools: ['read', 'grep', 'find', 'ls'] } : {}),
      ...(selector ? { model: resolvePiModel(runtime, selector, manager.getSessionId()) } : {}),
      ...(role === 'companion' && this.options.companionThinkingLevel ? { thinkingLevel: this.options.companionThinkingLevel } : {}),
      sessionManager: manager });
    activeSession = session;
    await session.bindExtensions({});
    if (session.model?.provider === 'opencode-go') await session.setModel(
      resolvePiModel(runtime, `${session.model.provider}/${session.model.id}`, manager.getSessionId()));
    this.active.add(session);
    const file = manager.getSessionFile();
    if (file) {
      if (role === 'companion') this.state.sessions.companion = file;
      else this.state.sessions.builders.push(file);
      try { this.store.save(this.state); } catch (error) { session.dispose(); this.active.delete(session); throw error; }
    }
    return session;
  }
  private async prompt(session: AgentSession, text: string, signal: AbortSignal, images: InlineAttachment[] = [], onDeadline?: () => void): Promise<string> {
    if (signal.aborted) throw new Error('Agent cancelled');
    if (images.length && !session.model?.input.includes('image')) throw new Error('The selected model does not support images. Choose a vision model or remove the images.');
    this.store.sessionDirectory('builder'); this.store.sessionDirectory('companion');
    const abort = () => { void session.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    let deadlineReached = false;
    const timeout = setTimeout(() => { deadlineReached = true; onDeadline?.(); abort(); }, providerDeadline(this.options));
    try {
      await session.prompt(text, { expandPromptTemplates: false, ...(images.length ? { images } : {}) });
      if (deadlineReached) throw new Error('Provider turn deadline reached; outcome is uncertain. Inspect saved input/work before explicitly retrying.');
      const last = session.messages.filter(m => m.role === 'assistant').at(-1);
      if (!last || last.role !== 'assistant') throw new Error('Pi returned no assistant response.');
      if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(last.errorMessage || `Pi ${last.stopReason}`);
      const reply = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!reply.trim()) throw new Error('Pi returned an empty response.');
      return reply;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
}
/** Reject invalid configuration before invoking a provider. */
export function providerDeadline(options: PiOptions): number {
  const deadline = options.providerTurnDeadlineMs ?? 10 * 60 * 1000;
  if (!Number.isSafeInteger(deadline) || deadline < 1 || deadline > 2147483647) throw new Error('providerTurnDeadlineMs must be a positive timer duration.');
  return deadline;
}
