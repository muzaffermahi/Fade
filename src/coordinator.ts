import { randomUUID } from 'node:crypto';
import { CompanionSchema, BuilderSchema, BuilderMessageSchema, InputReceiptSchema, IntentSchema, IntentUpdateSchema, WorkEventSchema, VerificationEvidenceSchema, RunLimitSchema, ConversationSchema, NativeReplySchema, ManualCheckActionSchema, validate, type BuilderResult, type CompanionReply,
  sessionConversation, type Intent, type ProjectState, type Slice, type BuilderMessage, type InputReceipt, type IntentUpdate, type WorkEvent } from './contracts.js';
import { Store } from './store.js';
import { ActivityTracker, isCheckCommand } from './activity.js';
import { notification, notificationText } from './notifications.js';
import type { FadeNotification } from './contracts.js';
import { prepareChecks, observeChecks, acceptanceStatus, verifiedSlice, checkReport } from './checks.js';
import { STORAGE_LIMITS, operationSummary } from './payloads.js';

/** Ports keep coordination tests independent from models and shell execution. */
export interface Agents {
  build(slice: Slice, signal: AbortSignal, event: (value: unknown) => void): Promise<BuilderResult>;
  converse(state: ProjectState, message: string, signal: AbortSignal, event?: (value: unknown) => void, sourceId?: string): Promise<CompanionReply>;
  steerBuilder?(message: BuilderMessage): Promise<'queued' | 'pending'>;
  refreshBuilderQueue?(prepareOnly?: boolean): Promise<void>;
  companionUsage?(): number | undefined;
  close(): void;
}
export type Notice = { role: 'builder' | 'companion' | 'system'; text: string; notification?: FadeNotification };
/** Shells may edit; only simple recognized check invocations are labelled checking. */
export function toolPhase(name: string, event: object): WorkEvent['phase'] {
  if (['read', 'grep', 'find', 'ls'].includes(name)) return 'inspecting';
  const args = 'args' in event && event.args && typeof event.args === 'object' ? event.args : undefined;
  const command = args && 'command' in args && typeof args.command === 'string' ? args.command.trim() : '';
  if (['bash', 'powershell'].includes(name) && isCheckCommand(command)) return 'checking';
  return 'editing';
}
const tentative = /\b(wonder|maybe|perhaps|might|possibly|not sure|could we|what if|thinking about)\b/i;
const implementation = /\b(implement|build|create|add|fix|change|replace|remove|use|make|want|need)\b|实现|构建|创建|添加|修复|改成/i;
/** Conservative activation: exploratory or attributed/quoted suggestions never authorize a slice. */
export function authorizesImplementation(message: string): boolean {
  const clauses = message.replace(/"[^"\n]*"|“[^”\n]*”|`[^`\n]*`/g, '').split(/[.!?\n;]|,?\s+but\s+/i);
  return clauses.some(clause => implementation.test(clause) && !tentative.test(clause)
    && !/\b(do not|don't|does not|doesn't|not asking|never|avoid|explore|compare|inspect|read|explain)\b|不要|别实现|探索|比较|解释/i.test(clause))
    && !/^\s*["'“‘`>]/.test(message)
    && !/\b(suggested|suggests|said|says|quoted|example)\b/.test(message.toLowerCase());
}

/** Historical failures remain visible; only the same command's observed success resolves one. */
function hasUnresolvedShellFailure(state: ProjectState, sliceId: string): boolean {
  const latest = new Map<string, boolean>();
  for (const evidence of state.verificationEvidence) {
    if (evidence.sliceId !== sliceId || !['bash', 'powershell'].includes(evidence.toolName)) continue;
    const input = evidence.input;
    const args = input && typeof input === 'object' && 'args' in input && input.args && typeof input.args === 'object' ? input.args : undefined;
    const command = args && 'command' in args && typeof args.command === 'string' ? args.command.trim() : '';
    latest.set(`${evidence.toolName}\0${evidence.commandHash ?? (command ? `command:${command}` : `unknown:${evidence.sequence}`)}`, evidence.isError);
  }
  return [...latest.values()].some(isError => isError);
}

/** Event-driven rolling handoff. In-flight code always sees an immutable brief. */
export class Coordinator {
  private buildTask: Promise<void> | undefined;
  private buildAbort: AbortController | undefined;
  private conversationAbort: AbortController | undefined;
  private conversationTask: Promise<void> | undefined;
  private closing = false;
  private needsReconciliation = false;
  private readonly appliedSources = new Set<string>();
  private transferring = false;
  private executionTask: Promise<void> | undefined;
  private readonly reconciledCompletions = new Set<string>();
  private storageError: string | undefined;
  private readonly storageOff: () => void;
  get persistenceFailure(): string | undefined { return this.storageError; }
  observeUsage(role: 'companion' | 'builder', tokens: number): void {
    if (this.storageError) return;
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Invalid observed token count.');
    (this.state.usage ??= {})[role] = { tokens, cost: null }; this.safePersist();
    this.activity.usage(role, tokens);
  }
  constructor(readonly state: ProjectState, readonly store: Store, readonly agents: Agents,
    private readonly notice: (notice: Notice) => void = () => {}, readonly activity = new ActivityTracker()) { this.storageOff = store.onStorageFailure(error => this.storageFailure(error)); }

  private feedback(kind: FadeNotification['kind'], role: FadeNotification['role'], operationId: string, cause: string,
    actions: FadeNotification['actions'], receiptId?: string): void {
    const item = notification({ kind, role, operationId, cause, actions, sessionId: (receiptId ? this.state.inputs.find(input => input.id === receiptId)?.sessionId : undefined) ?? this.state.currentSessionId, timestamp: Date.now(), ...(receiptId ? { receiptId } : {}) });
    this.notice({ role: 'system', text: notificationText(item), notification: item });
  }

  static initial(workspace: string, vision: string, preference: 'design' | 'technical' = 'design', runLimit = 4): ProjectState {
    validate(RunLimitSchema, runLimit);
    const id = randomUUID();
    return { version: 5, id, currentSessionId: id, inputs: [], workEvents: [], verificationEvidence: [],
      ownership: { owner: null, operation: null, transfer: null, interrupted: false }, workspace, revision: 0, mode: 'paused', preference,
      runLimit, remainingSlices: runLimit, intent: { revision: 0, vision, decisions: [], openQuestions: [] },
      slices: [],
      conversation: [], discoveries: [], history: [], sessions: { builders: [] } };
  }
  recover(): void {
    for (const input of this.state.inputs) if (['accepted', 'queued', 'processing'].includes(input.status)) {
      input.status = 'interrupted'; input.updatedAt = Date.now(); input.error = 'Recovered input; completion is uncertain. Use /retry-input explicitly.';
    }
    this.state.ownership = { owner: null, operation: null, transfer: null, interrupted: true };
    for (const slice of this.state.slices) {
      if (slice.status === 'running') slice.status = 'interrupted';
      for (const check of slice.checks ?? []) if (check.status === 'running') { check.status = 'not_run'; check.latestResult = 'Execution interrupted before a paired final result; explicit rerun required.'; }
    }
    for (const note of this.state.builderMessages ?? []) if (note.status !== 'received') { note.status = 'pending'; delete note.sliceId; }
    this.state.mode = 'paused'; this.persist();
    this.activity.finish('builder', 'paused');
  }
  start(): void { this.state.mode = 'running'; this.needsReconciliation ||= this.state.slices.some(s => s.status === 'reconcile'); this.persist(); this.schedule(); }
  resume(): void {
    if (this.closing) throw new Error('Project is closing.');
    if (this.buildTask || this.transferring || this.state.ownership.owner) throw new Error('Workspace execution is still stopping or owned by another role.');
    this.state.remainingSlices = this.state.runLimit ?? 4;
    for (const s of this.state.slices) if (s.status === 'interrupted' || s.status === 'blocked' || (s.status === 'completed' && s.checks?.length && !verifiedSlice(s))) {
      if (s.result?.status === 'completed' && acceptanceStatus(s) === 'needs_human_inspection') continue;
      s.status = 'ready'; delete s.snapshot;
    }
    this.start();
  }
  async pause(stop = false): Promise<void> {
    this.state.mode = stop ? 'stopped' : 'paused'; this.persist();
    const active = this.state.slices.find(s => s.status === 'running');
    if (active) this.work(active.id, { type: 'phase', phase: 'stopping' });
    this.activity.cancel('builder'); this.buildAbort?.abort(); await this.buildTask;
    if (!this.buildTask) this.activity.finish('builder', 'paused');
    this.notice({ role: 'system', text: stop ? 'Builder stopped. Your conversation remains available.' : 'Builder paused. Keep thinking, or /resume when ready.' });
  }
  /** Escape interrupts the Companion; unrelated Builder execution retains its lease. */
  async interrupt(): Promise<void> {
    const role = this.state.inputs.find(input => input.status === 'processing')?.role ?? 'companion';
    this.activity.cancel(role);
    this.conversationAbort?.abort();
    await this.conversationTask;
  }
  /** Stock operations execute only after Builder quiescence, under a Companion lease. */
  async withCompanionExecution<T>(operation: string, execute: () => Promise<T>): Promise<T> {
    if (this.closing || this.transferring || this.state.ownership.owner === 'companion') throw new Error('Workspace execution is already owned or transferring.');
    this.transferring = true; this.state.ownership.transfer = 'companion'; this.persist();
    try {
      await this.pause(this.state.mode === 'stopped');
      if (this.closing) throw new Error('Project is closing; execution transfer cancelled.');
      this.state.ownership = { owner: 'companion', operation, transfer: null, interrupted: false }; this.persist();
      const task = execute(); this.executionTask = task.then(() => {}, () => {});
      return await task;
    } finally {
      this.state.ownership = { owner: null, operation: null, transfer: null, interrupted: false };
      this.transferring = false; this.executionTask = undefined; this.persist();
      this.notice({ role: 'system', text: 'Workspace execution finished. Partial Builder work is saved; /continue resumes implementation.' });
    }
  }
  /** Only known stock inspection operations are safe to overlap with Builder execution. */
  companionToolAllowed(name: string): boolean {
    return ['read', 'grep', 'find', 'ls', 'fade_update_intent', 'fade_project_context'].includes(name);
  }
  /** A validated metadata-tool boundary may activate work before conversational prose completes. */
  proposeIntent(update: IntentUpdate, sourceId: string, expectedIntentRevision: number): void {
    if (this.closing || this.state.intent.revision !== expectedIntentRevision) throw new Error('Intent changed; proposal held for reconciliation.');
    const source = this.state.conversation.find(m => m.id === sourceId && m.role === 'human');
    if (!source || this.state.inputs.find(i => i.id === sourceId)?.sessionId !== this.state.currentSessionId) throw new Error('Missing current human source.');
    const proposal = validate(IntentUpdateSchema, update);
    this.apply({ reply: 'Intent proposal applied.', ...proposal }, sourceId, source.text);
    this.appliedSources.add(sourceId); this.persist(); this.schedule();
  }
  talk(message: string): Promise<void> {
    return this.converse(message, true);
  }
  get isConversing(): boolean { return Boolean(this.conversationTask); }
  /** Save before transport; Pi receipts distinguish queued notes from actual context delivery. */
  async messageBuilder(text: string, metadata: Partial<Pick<InputReceipt, 'mode' | 'attachments' | 'sessionId'>> = {}, accepted?: (receiptId: string) => void): Promise<BuilderMessage> {
    if (this.closing || !text.trim()) throw new Error('Write a message for the Builder.');
    const id = this.accept(text, { role: 'builder', mode: 'steer', ...metadata });
    accepted?.(id);
    const note = validate(BuilderMessageSchema, { id, text, timestamp: Date.now(), status: 'pending' });
    const active = this.state.slices.find(s => s.status === 'running');
    if (active) note.sliceId = active.id;
    (this.state.builderMessages ??= []).push(note); this.persist();
    if (active && this.agents.steerBuilder) {
      try {
        const disposition = await this.agents.steerBuilder(structuredClone(note));
        if (this.closing) return structuredClone(this.state.builderMessages?.find(n => n.id === note.id) ?? note);
        const current = this.state.builderMessages?.find(n => n.id === note.id);
        if (current && current.status !== 'received') current.status =
          current.sliceId && this.state.slices.some(s => s.id === current.sliceId && s.status === 'running') ? disposition : 'pending';
      } catch (error) {
        if (this.closing) return structuredClone(this.state.builderMessages?.find(n => n.id === note.id) ?? note);
        this.feedback('accepted_not_delivered', 'builder', note.id, `Builder delivery failed: ${errorText(error)}. Your note remains saved for the next slice.`, ['inputs'], note.id);
      }
      this.persist();
    }
    const saved = this.state.builderMessages?.find(n => n.id === note.id) ?? note;
    const receipt = this.input(note.id);
    if (receipt.status !== 'processed') receipt.status = saved.status === 'queued' ? 'queued' : 'accepted';
    receipt.updatedAt = Date.now(); this.persist();
    this.notice({ role: 'system', text: `Builder note ${note.id.slice(0, 8)} · ${saved.status === 'pending' ? 'saved for the next Builder turn' : saved.status === 'queued' ? 'queued in Pi; receipt pending' : 'received by the Builder'}.` });
    return structuredClone(saved);
  }
  /** Persist terminal input immediately, even when another reply is in flight. */
  accept(message: string, options: Partial<Pick<InputReceipt, 'sessionId' | 'role' | 'mode' | 'attachments'>> = {}): string {
    if (this.closing) throw new Error('Project is closing.');
    if (!message.trim()) throw new Error('Write an idea before sending.');
    if (this.state.inputs.filter(input => ['accepted', 'queued', 'processing'].includes(input.status)).length >= STORAGE_LIMITS.pendingInputs) {
      throw new Error('200 inputs are already pending. Inspect /inputs and cancel or finish queued work before sending; your draft is retained.');
    }
    this.store.validateNewImages(options.attachments ?? []);
    const source = { id: randomUUID(), role: 'human' as const, text: message, timestamp: Date.now() };
    const receipt = validate(InputReceiptSchema, { ...source, role: 'companion', sessionId: this.state.currentSessionId,
      mode: 'followUp', attachments: [], ...options, status: 'accepted', updatedAt: source.timestamp, attempts: 0, edits: [] });
    // Validate before changing either collection. Save before exposing the receipt id.
    this.state.inputs.push(receipt);
    this.state.conversation.push({ ...source, targetRole: receipt.role, scope: 'session', sessionId: receipt.sessionId, receiptId: receipt.id });
    try { this.persist(); } catch (error) {
      this.state.inputs = this.state.inputs.filter(i => i.id !== source.id);
      this.state.conversation = this.state.conversation.filter(m => m.id !== source.id);
      throw error;
    }
    return source.id;
  }
  /** Session navigation parks accepted work instead of silently changing its destination. */
  async switchSession(sessionId: string): Promise<void> {
    if (!sessionId.trim()) throw new Error('Missing session identity.');
    if (sessionId === this.state.currentSessionId) return;
    this.state.currentSessionId = sessionId;
    for (const input of this.state.inputs) if (input.sessionId !== sessionId && ['accepted', 'queued'].includes(input.status)) {
      if (input.role === 'builder' && this.state.builderMessages?.some(note => note.id === input.id && note.sliceId
        && this.state.slices.some(slice => slice.id === note.sliceId && slice.status === 'running'))) continue;
      input.status = 'interrupted'; input.updatedAt = Date.now(); input.error = 'Destination session changed. Return to that session and explicitly retry.';
    }
    this.persist(); this.conversationAbort?.abort(); await this.conversationTask;
  }
  /** Queue edits retain their previous text as provenance. Consumed input is immutable. */
  editInput(id: string, text: string): void {
    const input = this.input(id);
    if (!['accepted', 'queued', 'interrupted', 'failed'].includes(input.status)) throw new Error('Input is already processing or consumed.');
    validate(InputReceiptSchema, { ...input, text });
    input.edits.push({ text: input.text, timestamp: Date.now() }); input.text = text; input.updatedAt = Date.now();
    const source = this.state.conversation.find(m => m.id === id); if (source) source.text = text;
    const note = this.state.builderMessages?.find(m => m.id === id); if (note) note.text = text;
    this.persist();
  }
  cancelInput(id: string): void {
    const input = this.input(id);
    if (['processing', 'processed'].includes(input.status)) throw new Error('Use interruption for processing input.');
    input.status = 'cancelled'; input.updatedAt = Date.now(); this.persist();
  }
  retryInput(id: string): void {
    const input = this.input(id);
    if (!['failed', 'interrupted'].includes(input.status)) throw new Error('Only failed or interrupted input can be retried.');
    if (input.sessionId !== this.state.currentSessionId) throw new Error('Return to the input destination session before retrying.');
    this.store.validateNewImages(input.attachments);
    input.status = 'accepted'; delete input.error; input.updatedAt = Date.now(); this.persist();
  }
  queueInput(id: string): void { const input = this.input(id); if (input.status === 'accepted') { input.status = 'queued'; this.persist(); } }
  /** Native Pi emits this boundary when an accepted queue item enters its context. */
  consumeNativeInput(id: string): void {
    const input = this.input(id);
    if (input.sessionId !== this.state.currentSessionId || !['accepted', 'queued'].includes(input.status)) throw new Error('Native input destination or status changed.');
    input.status = 'processing'; input.attempts++; input.updatedAt = Date.now(); this.persist();
  }
  finishNativeInput(id: string, interrupted = false): void {
    const input = this.input(id);
    if (input.status !== 'processing' && input.status !== 'queued') return;
    input.status = interrupted ? 'interrupted' : 'processed'; input.updatedAt = Date.now(); this.appliedSources.delete(id); this.persist();
  }
  private input(id: string): InputReceipt {
    let input = this.state.inputs.find(i => i.id === id);
    if (!input) { input = this.store.findInput(id); if (input) this.state.inputs.push(input); }
    if (!input) throw new Error('Unknown input receipt.'); return input;
  }
  async waitForConversation(): Promise<void> {
    while (this.conversationTask) await this.conversationTask;
  }
  talkAccepted(sourceId: string): Promise<void> {
    const input = this.input(sourceId);
    if (input.status === 'processed' || input.status === 'cancelled') return Promise.resolve();
    if (!['accepted', 'queued'].includes(input.status)) return Promise.reject(new Error('Input requires explicit retry.'));
    if (input.sessionId !== this.state.currentSessionId) return Promise.reject(new Error('Input belongs to another session; it remains saved.'));
    const source = this.state.conversation.find(m => m.id === sourceId && m.role === 'human');
    const saved = source ?? this.store.findConversation(sourceId);
    if (!saved || saved.role !== 'human') return Promise.reject(new Error('Missing saved human message.'));
    if (!source) this.state.conversation.push(saved);
    return this.converse(saved.text, true, sourceId);
  }
  private converse(message: string, human: boolean, acceptedId?: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Project is closing.'));
    if (this.conversationTask) return Promise.reject(new Error('Companion is still listening to your previous message. Your draft is retained.'));
    if (human && !message.trim()) return Promise.reject(new Error('Write an idea before sending.'));
    const sourceId = acceptedId ?? (human ? this.accept(message) : randomUUID());
    const receipt = human ? this.input(sourceId) : undefined;
    if (receipt) { receipt.status = 'processing'; receipt.attempts++; receipt.updatedAt = Date.now(); this.persist(); }
    const snapshot = structuredClone(this.state), revision = snapshot.intent.revision;
    snapshot.conversation = sessionConversation(snapshot);
    const sessionId = receipt?.sessionId ?? snapshot.currentSessionId;
    const role = receipt?.role ?? 'companion';
    this.activity.begin(role, this.state.currentSessionId, sourceId);
    const controller = new AbortController(); this.conversationAbort = controller;
    let observedReplyId: string | undefined;
    this.conversationTask = (async () => {
      try {
        this.activity.update(role, 'waiting_for_provider', 'Waiting for provider');
        const answer = validate(CompanionSchema, await this.agents.converse(snapshot, message, controller.signal, event => {
          if (event && typeof event === 'object' && 'type' in event && event.type === 'fade_reply_observed') {
            const observation = validate(NativeReplySchema, event);
            const input = observation.receiptId ? this.state.inputs.find(input => input.id === observation.receiptId) : undefined;
            if (this.closing || controller.signal.aborted || observation.sessionId !== sessionId || observation.sessionId !== this.state.currentSessionId
              || (observation.receiptId && (!input || input.sessionId !== observation.sessionId || input.status !== 'processing'))) return;
            const record = validate(ConversationSchema, { id: observation.id, role: 'companion', text: observation.text, timestamp: observation.timestamp,
              scope: 'session', sessionId: observation.sessionId, targetRole: input?.role ?? 'companion', applied: observation.receiptId ? this.appliedSources.has(observation.receiptId) : false,
              ...(observation.receiptId ? { receiptId: observation.receiptId } : {}) });
            if (!this.state.conversation.some(message => message.id === record.id)) { this.state.conversation.push(record); this.persist(); }
            observedReplyId = record.id; return;
          }
          if (this.activity.get(role).operationId === sourceId) this.activity.observe(role, event);
          if (event && typeof event === 'object' && 'type' in event && event.type === 'tool_execution_end' && 'isError' in event && event.isError === true) {
            const tool = 'toolName' in event && typeof event.toolName === 'string' ? event.toolName : 'Tool';
            this.feedback('tool_failure', role, sourceId, `${tool} failed; its observed output remains available in native Pi.`, ['pi', 'inputs'], receipt?.id);
          }
        }, sourceId));
        const tokens = this.agents.companionUsage?.(); if (tokens !== undefined) this.observeUsage('companion', tokens);
        if (!human && answer.evidence.length) throw new Error('A discovery event cannot create new human decisions.');
        if (controller.signal.aborted || (receipt && receipt.sessionId !== this.state.currentSessionId)) throw new Error('Conversation interrupted; your message is saved.');
        let applied = false;
        const observedReply = observedReplyId ? this.state.conversation.find(record => record.id === observedReplyId) : undefined;
        if (observedReply?.applied || this.appliedSources.delete(sourceId)) applied = true;
        else if (revision === this.state.intent.revision) {
          this.apply(answer, sourceId, message); applied = true;
        } else this.feedback('intent_conflict', role, sourceId, 'Intent changed during this reply. The reply is saved; its proposed changes were held.', ['intent', 'rethink'], receipt?.id);
        if (observedReply) { const saved = this.state.conversation.find(record => record.id === observedReply.id); if (saved) saved.applied ||= applied; }
        else this.state.conversation.push({ id: randomUUID(), role: 'companion', text: answer.reply,
          timestamp: Date.now(), applied, targetRole: receipt?.role ?? 'companion', scope: 'session', sessionId, ...(receipt ? { receiptId: receipt.id } : {}) });
        if (receipt) { const current = this.input(sourceId); current.status = 'processed'; current.updatedAt = Date.now(); }
        this.persist();
        if (this.activity.get(role).operationId === sourceId) this.activity.finish(role, 'completed');
        this.notice({ role: 'companion', text: answer.reply });
      } catch (error) {
        if (receipt) { const current = this.input(sourceId); current.status = controller.signal.aborted ? 'interrupted' : 'failed'; current.error = errorText(error); current.updatedAt = Date.now(); this.safePersist(); }
        if (!this.storageError && this.activity.get(role).operationId === sourceId) this.activity.finish(role, controller.signal.aborted ? 'paused' : 'failed', errorText(error), ['inputs', 'diagnostics']);
        this.feedback(controller.signal.aborted ? 'uncertain_delivery' : 'provider_failure', role, sourceId,
          `${errorText(error)} ${human ? 'Your input remains saved; no automatic retry.' : 'Future briefs remain held.'}`, human ? ['inputs', 'retry-input', 'diagnostics'] : ['rethink', 'diagnostics'], receipt?.id);
      } finally {
        this.appliedSources.delete(sourceId);
        this.conversationTask = undefined; this.conversationAbort = undefined; this.schedule();
      }
    })();
    return this.conversationTask;
  }
  /** Import is explicit, revision checked, and never alters an active brief. */
  editIntent(intent: Intent): void {
    validate(IntentSchema, intent);
    if (intent.decisions.filter(decision => decision.status !== 'superseded').length > 256) throw new Error('More than 256 live intent items require human review; existing intent is preserved.');
    if (intent.revision !== this.state.intent.revision) throw new Error('Stale intent revision. Inspect the current .fade/intent.json before reapplying edits.');
    const changed = intent.decisions.filter(decision => { const old = this.state.intent.decisions.find(d => d.id === decision.id); return !old || old.text !== decision.text || old.status !== decision.status || old.kind !== decision.kind; });
    const sourceId = this.accept([...changed.map(d => d.text), ...(intent.vision !== this.state.intent.vision ? [intent.vision] : [])].join('\n') || 'Human reviewed and saved intent.');
    const updated = structuredClone(intent);
    for (const decision of updated.decisions) {
      const old = this.state.intent.decisions.find(d => d.id === decision.id);
      if (!old || old.text !== decision.text || old.status !== decision.status || old.kind !== decision.kind) { decision.sourceId = sourceId; decision.quote = decision.text; }
    }
    this.state.intent = updated;
    const receipt = this.state.inputs.find(i => i.id === sourceId); if (receipt) { receipt.status = 'processed'; receipt.updatedAt = Date.now(); }
    for (const s of this.state.slices) if (['ready', 'draft'].includes(s.status)) s.status = 'reconcile';
    this.recordIntent('Human edited intent'); this.persist();
    this.notice({ role: 'system', text: 'Your intent is saved. Future briefs need reconciliation; /rethink connects the changes. The active slice keeps its brief.' });
  }
  async redirect(message: string, sessionId = this.state.currentSessionId): Promise<void> {
    await this.pause();
    for (const s of this.state.slices) if (s.status !== 'completed') s.status = 'cancelled';
    this.state.mode = 'running'; this.persist(); await this.talkAccepted(this.accept(message, { sessionId }));
  }
  /** Called only by an explicit human command, never by model metadata tools. */
  recordManualCheck(request: unknown, accepted?: (receiptId: string) => void): string {
    const action = validate(ManualCheckActionSchema, request);
    if (!action.evidence.trim()) throw new Error('Record concrete human inspection evidence.');
    for (const slice of this.state.slices) for (const check of slice.checks ?? []) {
      const previous = check.history.find(attempt => attempt.source === 'human' && attempt.commandId === action.commandId);
      if (previous?.source === 'human') {
        if (slice.id !== action.sliceId || check.id !== action.checkId || previous.status !== (action.passed ? 'passed' : 'failed') || previous.evidence !== action.evidence) throw new Error('Manual acceptance commandId conflicts with an earlier decision.');
        return previous.receiptId;
      }
    }
    const archived = this.store.findManualAction(action.commandId);
    if (archived?.attempt.source === 'human') {
      if (archived.sliceId !== action.sliceId || archived.checkId !== action.checkId || archived.attempt.status !== (action.passed ? 'passed' : 'failed') || archived.attempt.evidence !== action.evidence) throw new Error('Manual acceptance commandId conflicts with an earlier decision.');
      return archived.attempt.receiptId;
    }
    if (this.closing || this.storageError || action.expectedRevision !== this.state.revision) throw new Error('Stale or unavailable project revision; inspect /builder before recording acceptance.');
    const hotSlice = this.state.slices.find(slice => slice.id === action.sliceId), slice = hotSlice ?? this.store.findSlice(action.sliceId);
    let check = slice?.checks?.find(check => check.id === action.checkId);
    if (!slice || !check || check.definition.kind !== 'manual') throw new Error('Manual acceptance requires a known manual check.');
    if (slice.status === 'running' || ['cancelled', 'ready', 'draft', 'reconcile', 'interrupted'].includes(slice.status) || slice.result?.status !== 'completed') throw new Error('Inspect the completed implementation after Builder quiesces before manual acceptance.');
    if (!hotSlice) this.state.slices.push(slice);
    const receiptId = this.accept(`Human inspection ${slice.id}/${check.id}: ${action.passed ? 'passed' : 'failed'}\n${action.evidence}`, { role: 'builder' });
    accepted?.(receiptId);
    check = this.state.slices.find(current => current.id === slice.id)?.checks?.find(current => current.id === action.checkId);
    if (!check) throw new Error('Accepted human inspection has no current check; inspect its receipt before retrying.');
    check.status = action.passed ? 'passed' : 'failed'; check.latestResult = action.evidence;
    check.history.push({ source: 'human', commandId: action.commandId, receiptId, timestamp: Date.now(), status: check.status, evidence: action.evidence });
    const receipt = this.input(receiptId); receipt.status = 'processed'; receipt.updatedAt = Date.now();
    slice.status = acceptanceStatus(slice) === 'passed' && !hasUnresolvedShellFailure(this.state, slice.id) ? 'completed' : 'blocked';
    this.persist(); this.notice({ role: 'system', text: `Human acceptance recorded. ${checkReport(slice)}` }); this.schedule(); return receiptId;
  }
  async idle(): Promise<void> {
    while (this.buildTask || this.conversationTask) await Promise.all([this.buildTask, this.conversationTask]);
  }
  async close(): Promise<void> {
    this.closing = true; this.conversationAbort?.abort(); this.buildAbort?.abort();
    try {
      if (!this.storageError) await this.pause();
      await this.buildTask; await this.conversationTask; await this.executionTask;
    } finally { this.storageOff(); this.agents.close(); this.store.close(); }
  }
  private apply(answer: CompanionReply, sourceId: string, human: string): void {
    const candidate = structuredClone(this.state);
    const changed = new Set<string>();
    for (const e of answer.evidence) {
      if (!human.includes(e.quote)) throw new Error('Decision evidence must quote the current human message verbatim.');
      const sourceClause = human.split(/[.!?\n;]/).find(clause => clause.includes(e.quote)) ?? human;
      const kind = tentative.test(sourceClause) || /^\s*["'“‘`>]/.test(human) ? 'tentative' : e.kind;
      const existing = candidate.intent.decisions.find(d => d.key === e.key && d.status === 'active' && d.kind !== 'tentative');
      const replaced = e.replaces ? candidate.intent.decisions.find(d => d.id === e.replaces && d.key === e.key && d.status !== 'superseded') : undefined;
      if (existing?.text === e.text && existing.kind === kind) continue;
      let status: 'active' | 'conflict' = 'active';
      if (replaced && kind !== 'tentative') {
        for (const d of candidate.intent.decisions) if (d.key === e.key) d.status = 'superseded';
        changed.add(e.key);
      } else if (existing && kind !== 'tentative') {
        existing.status = 'conflict'; status = 'conflict';
        changed.add(e.key);
      } else if (kind !== 'tentative' && candidate.intent.decisions.some(d => d.key === e.key && d.status === 'conflict')) {
        status = 'conflict'; changed.add(e.key);
      }
      candidate.intent.decisions.push({ id: randomUUID(), key: e.key, text: e.text,
        quote: e.quote, kind, sourceId, status });
    }
    candidate.intent.openQuestions = answer.openQuestions;
    if (candidate.intent.decisions.filter(decision => decision.status !== 'superseded').length > 256) throw new Error('More than 256 live intent items require human review before adding new work; existing intent is preserved.');
    for (const s of candidate.slices) if (['ready', 'draft'].includes(s.status) &&
      s.plan.decisionKeys.some(key => changed.has(key))) s.status = 'reconcile';
    if (answer.next) {
      const plan = answer.next;
      const active = candidate.slices.find(s => s.status === 'running') ?? candidate.slices.findLast(s => s.status === 'blocked' && s.result?.status === 'completed' && !verifiedSlice(s));
      if (active && !plan.dependencies.includes(active.id)) plan.dependencies.push(active.id);
      const valid = plan.decisionKeys.every(key => candidate.intent.decisions.some(d => d.key === key && d.status === 'active' && d.kind !== 'tentative'));
      const dependenciesExist = plan.dependencies.every(id => candidate.slices.some(s => s.id === id));
      if (!dependenciesExist) throw new Error('Next slice refers to an unknown dependency.');
      const unresolved = candidate.intent.decisions.some(d => d.status === 'conflict' && plan.decisionKeys.includes(d.key));
      const supportedRequest = plan.decisionKeys.some(key => candidate.intent.decisions.some(d => d.key === key && d.status === 'active' && d.kind !== 'tentative'
        && candidate.conversation.some(m => m.id === d.sourceId && m.role === 'human' && authorizesImplementation(m.text))));
      if (plan.ready && (!plan.requirements.length || !plan.decisionKeys.length || !plan.acceptanceChecks?.length || !valid || unresolved || !supportedRequest)) throw new Error('A ready slice needs requirements, acceptance checks and nonempty settled references to a human implementation request.');
      // Replace only the single future slot. Preserve prior briefs as cancelled history.
      for (const s of candidate.slices) if (['ready', 'draft', 'reconcile', 'blocked', 'cancelled'].includes(s.status) && !(s.status === 'blocked' && s.result?.status === 'completed')) s.status = 'cancelled';
      candidate.slices.push({ id: randomUUID(), plan, checks: prepareChecks(plan), status: plan.ready ? 'ready' : 'draft' });
    }
    // Keep the running object identity: its completion callback still owns it.
    candidate.slices = candidate.slices.map(s => this.state.slices.find(old => old.id === s.id && old.status === 'running') ?? s);
    Object.assign(this.state, candidate);
    if (answer.next?.ready && this.state.mode === 'paused' && this.state.slices.length === 1 && authorizesImplementation(human)) this.state.mode = 'running';
    this.recordIntent('Companion translated human thinking');
  }
  private recordIntent(reason: string): void {
    this.state.intent.revision++;
    this.state.history.push({ timestamp: Date.now(), reason, intent: structuredClone(this.state.intent) });
  }
  private schedule(): void {
    if (this.closing || this.storageError) return;
    // A draft based on an in-flight result must be revalidated once that result exists.
    const held = this.state.slices.findLast(s => ['draft', 'reconcile'].includes(s.status) && s.plan.dependencies.length > 0
      && s.plan.dependencies.every(id => this.state.slices.some(d => d.id === id && verifiedSlice(d))));
    if (held && held.plan.dependencies.some(id => !this.reconciledCompletions.has(id))) {
      for (const id of held.plan.dependencies) this.reconciledCompletions.add(id);
      this.needsReconciliation = true;
    }
    if (this.needsReconciliation && !this.conversationTask) {
      this.needsReconciliation = false;
      this.notice({ role: 'system', text: 'The Companion is reconciling a changed implementation assumption with your existing intent.' });
      void this.converse('', false);
    }
    if (this.closing || this.buildTask || this.transferring || this.state.ownership.owner || this.state.mode !== 'running' || !this.state.remainingSlices) return;
    const slice = this.state.slices.find(s => s.status === 'ready' && s.plan.dependencies.every(id =>
      this.state.slices.some(d => d.id === id && verifiedSlice(d))));
    if (!slice) return;
    if (!slice.plan.decisionKeys.length || !slice.plan.acceptanceChecks?.length || slice.plan.decisionKeys.some(key => !this.state.intent.decisions.some(d => d.key === key && d.kind !== 'tentative' && d.status === 'active'))) {
      slice.status = 'reconcile'; this.persist(); return;
    }
    slice.snapshot = structuredClone({ intent: this.state.intent, requirements: slice.plan.requirements, goal: slice.plan.goal });
    const priorSequence = (slice.checks ?? []).reduce((latest, check) => check.history.reduce((maximum, attempt) =>
      attempt.source === 'execution' ? Math.max(maximum, attempt.sequence) : maximum, latest),
    Math.max(slice.lastSequence ?? 0, this.state.workEvents.findLast(event => event.sliceId === slice.id)?.sequence ?? 0));
    slice.lastSequence = priorSequence;
    slice.checks = prepareChecks(slice.plan, priorSequence, slice.checks);
    for (const note of this.state.builderMessages ?? []) if (note.status === 'pending' && this.state.inputs.some(i => i.id === note.id && i.sessionId === this.state.currentSessionId && ['accepted', 'queued'].includes(i.status))) note.sliceId = slice.id;
    slice.status = 'running'; this.state.remainingSlices--;
    this.activity.begin('builder', this.state.currentSessionId, slice.id);
    this.state.ownership = { owner: 'builder', operation: slice.id, transfer: null, interrupted: false }; this.persist();
    try { this.work(slice.id, { type: 'phase', phase: 'inspecting' }); } catch (error) {
      this.storageFailure(error); slice.status = 'interrupted'; this.state.ownership.owner = null; return;
    }
    const controller = new AbortController(); this.buildAbort = controller;
    this.notice({ role: 'builder', text: `Building: ${slice.plan.title}` });
    this.buildTask = (async () => {
      try {
        this.activity.update('builder', 'waiting_for_provider', 'Waiting for provider');
        const result = validate(BuilderSchema, await this.agents.build(structuredClone(slice), controller.signal, event => {
          if (controller.signal.aborted || this.closing || slice.status !== 'running') return;
          try {
          this.activity.observe('builder', event);
          if (event && typeof event === 'object' && 'type' in event && event.type === 'role_usage' && 'tokens' in event && typeof event.tokens === 'number') this.observeUsage('builder', event.tokens);
          // Prose is transient; retain the existing durable tool/receipt event boundary.
          const rawReference = !(event && typeof event === 'object' && 'type' in event && event.type === 'message_update') ? this.store.event({ sliceId: slice.id, event }) : undefined;
          if (event && typeof event === 'object' && 'type' in event && 'toolName' in event && typeof event.toolName === 'string') {
            const startEvent = 'toolCallId' in event ? this.state.workEvents.findLast(e => e.sliceId === slice.id && e.operationId === event.toolCallId && e.type === 'tool_start') : undefined;
            const phase = startEvent?.phase ?? toolPhase(event.toolName, event);
            const operationId = 'toolCallId' in event && typeof event.toolCallId === 'string' ? event.toolCallId : randomUUID();
            if (event.type === 'tool_execution_start' || event.type === 'tool_execution_update' || event.type === 'tool_execution_end') {
              const record = this.work(slice.id, { type: event.type === 'tool_execution_start' ? 'tool_start' : event.type === 'tool_execution_update' ? 'tool_update' : 'tool_end', phase,
                toolName: event.toolName, operationId, payload: event, isError: 'isError' in event && event.isError === true }, false, rawReference);
              if (record.type === 'tool_end' && 'result' in event) {
                const start = this.state.workEvents.findLast(e => e.sliceId === slice.id && e.operationId === operationId && e.type === 'tool_start');
                this.state.verificationEvidence.push(validate(VerificationEvidenceSchema, { sliceId: slice.id, sequence: record.sequence,
                  operationId, toolName: event.toolName, timestamp: record.timestamp, isError: record.isError ?? false, input: start?.payload ?? null, result: event.result,
                  ...(start?.payloadRef ? { inputRef: start.payloadRef } : {}), ...(start?.commandHash ? { commandHash: start.commandHash } : {}) }));
                if (record.isError) this.feedback('tool_failure', 'builder', slice.id, `${event.toolName} failed; inspect the observed output.`, ['log', 'builder']);
              }
            }
            if (event.type !== 'tool_execution_update') { slice.checks = observeChecks(slice, this.state); this.persist(); }
          }
          if (event && typeof event === 'object' && 'type' in event && event.type === 'builder_note_received'
            && 'id' in event && typeof event.id === 'string') {
            const note = this.state.builderMessages?.find(n => n.id === event.id && n.sliceId === slice.id);
            if (note && note.status !== 'received') {
              const receipt = this.state.inputs.find(i => i.id === note.id);
              if (receipt && ['cancelled', 'interrupted', 'failed'].includes(receipt.status)) return;
              note.status = 'received';
              if (receipt) { receipt.status = 'processed'; receipt.updatedAt = Date.now(); }
              this.persist();
              this.notice({ role: 'system', text: `Builder received note ${note.id.slice(0, 8)}.` });
            }
          }
          if (typeof event === 'string') this.notice({ role: 'builder', text: event });
          } catch (error) { this.storageFailure(error); }
        }));
        if (controller.signal.aborted) { slice.status = 'interrupted'; return; }
        slice.result = result; slice.status = result.status;
        slice.checks = observeChecks(slice, this.state, true);
        if (result.status === 'completed' && (acceptanceStatus(slice) !== 'passed' || hasUnresolvedShellFailure(this.state, slice.id))) {
          slice.status = 'blocked';
          this.feedback('verification_failure', 'builder', slice.id, `Implementation reported completed; acceptance ${acceptanceStatus(slice).replaceAll('_', ' ')}${hasUnresolvedShellFailure(this.state, slice.id) ? '; unresolved observed shell failure' : ''}. Dependent work remains held.`, ['builder', 'log']);
        }
        this.state.discoveries.push(...result.discoveries);
        if (result.discoveries.length) {
          for (const future of this.state.slices) if (['ready', 'draft'].includes(future.status) && result.discoveries.some(d =>
            d.affects.includes('*') || future.plan.assumptions.some(a => d.affects.includes(a)) ||
            future.plan.decisionKeys.some(k => d.affects.includes(k)) || d.affects.includes(future.id))) {
            future.status = 'reconcile'; this.needsReconciliation = true;
          }
          this.recordIntent('Builder discovery: future assumptions need review');
        }
        this.notice({ role: 'builder', text: `${slice.status}: ${result.summary}` });
        if (slice.plan.decisionKeys.length) this.notice({ role: 'system', text: `This slice carried your decisions: ${slice.plan.decisionKeys.join(', ')}. /intent shows their source.` });
      } catch (error) {
        slice.status = controller.signal.aborted ? 'interrupted' : 'blocked';
        if (!controller.signal.aborted) slice.result = { status: 'blocked', summary: errorText(error), verification: [], discoveries: [] };
        this.notice({ role: 'builder', text: `${slice.status}: ${errorText(error)}` });
        this.feedback(controller.signal.aborted ? 'uncertain_delivery' : 'provider_failure', 'builder', slice.id, errorText(error), ['builder', 'log', 'diagnostics']);
      } finally {
        slice.checks = observeChecks(slice, this.state, true);
        for (const note of this.state.builderMessages ?? []) if (note.sliceId === slice.id && note.status !== 'received') {
          note.status = 'pending'; delete note.sliceId;
        }
        this.buildTask = undefined; this.buildAbort = undefined;
        if (!this.storageError) this.activity.finish('builder', slice.status === 'interrupted' ? 'paused' : slice.status === 'completed' ? 'completed' : 'blocked', slice.result?.status === 'blocked' ? slice.result.summary : undefined, slice.status === 'completed' ? [] : ['builder', 'log']);
        this.state.ownership = { owner: null, operation: null, transfer: this.transferring ? 'companion' : null, interrupted: slice.status === 'interrupted' };
        if (!this.storageError) { try { this.work(slice.id, { type: 'outcome', phase: slice.status === 'completed' ? 'completed' : 'blocked', payload: slice.result ?? slice.status }); this.safePersist(); } catch (error) { this.storageFailure(error); } }
        if (!this.state.remainingSlices) this.notice({ role: 'system', text: `${this.state.runLimit ?? 4}-slice run limit reached. /continue starts another run.` });
        this.schedule();
      }
    })();
  }
  private work(sliceId: string, event: Omit<WorkEvent, 'sliceId' | 'sequence' | 'timestamp'>, persist = true, reference?: import('./contracts.js').PayloadReference): WorkEvent {
    const slice = this.state.slices.find(slice => slice.id === sliceId);
    const sequence = Math.max(slice?.lastSequence ?? 0, this.state.workEvents.findLast(e => e.sliceId === sliceId)?.sequence ?? 0) + 1;
    const record = validate(WorkEventSchema, { ...event, sliceId, sequence, timestamp: Date.now() });
    if (slice) slice.lastSequence = sequence;
    if (record.type === 'tool_update') { record.payload = operationSummary(record.payload); this.state.workEvents = this.state.workEvents.filter(old => !(old.sliceId === sliceId && old.operationId === record.operationId && old.type === 'tool_update')); }
    else this.store.compactWorkEvent(record, reference);
    this.state.workEvents.push(record); this.store.event(record); if (persist) this.persist(); return record;
  }
  private storageFailure(error: unknown): void {
    this.storageError ??= errorText(error); this.state.mode = 'paused'; this.buildAbort?.abort(); this.conversationAbort?.abort();
    for (const role of ['builder', 'companion'] as const) this.activity.finish(role, 'failed', this.storageError, ['restart', 'inputs']);
    this.feedback('storage_failure', this.state.ownership.owner ?? 'companion', this.state.ownership.operation ?? 'storage', `Storage failure: ${this.storageError}. Execution is paused. Unsaved input was not accepted. Previously durable state remains on disk.`, ['restart', 'inputs']);
  }
  private safePersist(): void { try { this.persist(); } catch { /* persist already reports and stops execution */ } }
  private persist(): void {
    if (this.storageError) throw new Error(`Storage unavailable: ${this.storageError}. Restart after repairing storage.`);
    this.state.revision++;
    try { this.store.save(this.state); } catch (error) { this.storageFailure(error); throw error; }
    for (const role of ['builder', 'companion'] as const) this.activity.queue(role, this.state.currentSessionId, this.state.inputs.filter(input => input.sessionId === this.state.currentSessionId && input.role === role && ['accepted', 'queued'].includes(input.status)).length);
  }
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
