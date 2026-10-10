import { randomUUID } from 'node:crypto';
import { CompanionSchema, BuilderSchema, validate, type BuilderResult, type CompanionReply,
  type Intent, type ProjectState, type Slice } from './contracts.js';
import { Store } from './store.js';

/** Ports keep coordination tests independent from models and shell execution. */
export interface Agents {
  build(slice: Slice, signal: AbortSignal, event: (value: unknown) => void): Promise<BuilderResult>;
  converse(state: ProjectState, message: string, signal: AbortSignal): Promise<CompanionReply>;
  close(): void;
}
export type Notice = { role: 'builder' | 'companion' | 'system'; text: string };
const tentative = /\b(wonder|maybe|perhaps|might|possibly|not sure|could we|what if|thinking about)\b/i;

/** Event-driven rolling handoff. In-flight code always sees an immutable brief. */
export class Coordinator {
  private buildTask: Promise<void> | undefined;
  private buildAbort: AbortController | undefined;
  private conversationAbort: AbortController | undefined;
  private conversationTask: Promise<void> | undefined;
  private closing = false;
  private needsReconciliation = false;
  constructor(readonly state: ProjectState, readonly store: Store, readonly agents: Agents,
    private readonly notice: (notice: Notice) => void = () => {}) {}

  static initial(workspace: string, vision: string, preference: 'design' | 'technical' = 'design'): ProjectState {
    return { version: 1, id: randomUUID(), workspace, revision: 0, mode: 'paused', preference,
      remainingSlices: 4, intent: { revision: 0, vision, decisions: [], openQuestions: [] },
      slices: [{ id: randomUUID(), status: 'ready', plan: { title: 'First working thread',
        goal: 'Build the smallest runnable foundation of this idea. Choose a bounded walking skeleton, document how to run it, and verify it. Leave consequential product choices open.',
        requirements: [vision], decisionKeys: [], dependencies: [], assumptions: [], ready: true } }],
      conversation: [], discoveries: [], history: [], sessions: { builders: [] } };
  }
  recover(): void {
    for (const slice of this.state.slices) if (slice.status === 'running') slice.status = 'interrupted';
    this.state.mode = 'paused'; this.persist();
  }
  start(): void { this.state.mode = 'running'; this.needsReconciliation ||= this.state.slices.some(s => s.status === 'reconcile'); this.persist(); this.schedule(); }
  resume(): void {
    if (this.closing) throw new Error('Project is closing.');
    if (this.buildTask) throw new Error('Builder is still stopping.');
    this.state.remainingSlices = 4;
    for (const s of this.state.slices) if (s.status === 'interrupted' || s.status === 'blocked') {
      s.status = 'ready'; delete s.snapshot;
    }
    this.start();
  }
  async pause(stop = false): Promise<void> {
    this.state.mode = stop ? 'stopped' : 'paused'; this.persist();
    this.buildAbort?.abort(); await this.buildTask;
    this.notice({ role: 'system', text: stop ? 'Builder stopped. Your conversation remains available.' : 'Builder paused. Keep thinking, or /resume when ready.' });
  }
  /** Explicit terminal interruption cancels conversation and pauses code execution. */
  async interrupt(): Promise<void> {
    this.conversationAbort?.abort();
    await this.pause(); await this.conversationTask;
  }
  talk(message: string): Promise<void> {
    return this.converse(message, true);
  }
  get isConversing(): boolean { return Boolean(this.conversationTask); }
  /** Persist terminal input immediately, even when another reply is in flight. */
  accept(message: string): string {
    if (this.closing) throw new Error('Project is closing.');
    if (!message.trim()) throw new Error('Write an idea before sending.');
    const source = { id: randomUUID(), role: 'human' as const, text: message, timestamp: Date.now() };
    this.state.conversation.push(source); this.persist();
    return source.id;
  }
  async waitForConversation(): Promise<void> {
    while (this.conversationTask) await this.conversationTask;
  }
  talkAccepted(sourceId: string): Promise<void> {
    const source = this.state.conversation.find(m => m.id === sourceId && m.role === 'human');
    if (!source) return Promise.reject(new Error('Missing saved human message.'));
    return this.converse(source.text, true, sourceId);
  }
  private converse(message: string, human: boolean, acceptedId?: string): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Project is closing.'));
    if (this.conversationTask) return Promise.reject(new Error('Companion is still listening to your previous message. Your draft is retained.'));
    if (human && !message.trim()) return Promise.reject(new Error('Write an idea before sending.'));
    const sourceId = acceptedId ?? (human ? this.accept(message) : randomUUID());
    const snapshot = structuredClone(this.state), revision = snapshot.intent.revision;
    const controller = new AbortController(); this.conversationAbort = controller;
    this.conversationTask = (async () => {
      try {
        const answer = validate(CompanionSchema, await this.agents.converse(snapshot, message, controller.signal));
        if (!human && answer.evidence.length) throw new Error('A discovery event cannot create new human decisions.');
        if (controller.signal.aborted) throw new Error('Conversation interrupted; your message is saved.');
        let applied = false;
        if (revision === this.state.intent.revision) {
          this.apply(answer, sourceId, message); applied = true;
        } else this.notice({ role: 'system', text: 'Intent changed during this reply. The reply is saved; its proposed changes were held. /rethink reconciles the latest state.' });
        this.state.conversation.push({ id: randomUUID(), role: 'companion', text: answer.reply,
          timestamp: Date.now(), applied }); this.persist();
        this.notice({ role: 'companion', text: answer.reply });
      } catch (error) {
        this.notice({ role: 'system', text: `Companion: ${errorText(error)} ${human ? 'Your message is saved;' : 'Future briefs remain held;'} /rethink retries with context.` });
      } finally {
        this.conversationTask = undefined; this.conversationAbort = undefined; this.schedule();
      }
    })();
    return this.conversationTask;
  }
  /** Import is explicit, revision checked, and never alters an active brief. */
  editIntent(intent: Intent): void {
    if (intent.revision !== this.state.intent.revision) throw new Error('Stale intent revision. Inspect the current .fade/intent.json before reapplying edits.');
    this.state.intent = structuredClone(intent);
    for (const s of this.state.slices) if (['ready', 'draft'].includes(s.status)) s.status = 'reconcile';
    this.recordIntent('Human edited intent'); this.persist();
    this.notice({ role: 'system', text: 'Your intent is saved. Future briefs need reconciliation; /rethink connects the changes. The active slice keeps its brief.' });
  }
  async redirect(message: string): Promise<void> {
    await this.pause();
    for (const s of this.state.slices) if (s.status !== 'completed') s.status = 'reconcile';
    this.persist(); await this.talk(message);
  }
  async idle(): Promise<void> {
    while (this.buildTask || this.conversationTask) await Promise.all([this.buildTask, this.conversationTask]);
  }
  async close(): Promise<void> {
    this.closing = true; this.conversationAbort?.abort(); await this.pause();
    await this.conversationTask; this.agents.close(); this.store.close();
  }
  private apply(answer: CompanionReply, sourceId: string, human: string): void {
    const candidate = structuredClone(this.state);
    const changed = new Set<string>();
    for (const e of answer.evidence) {
      if (!human.includes(e.quote)) throw new Error('Decision evidence must quote the current human message verbatim.');
      const kind = tentative.test(e.quote) ? 'tentative' : e.kind;
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
    for (const s of candidate.slices) if (['ready', 'draft'].includes(s.status) &&
      s.plan.decisionKeys.some(key => changed.has(key))) s.status = 'reconcile';
    if (answer.next) {
      const plan = answer.next;
      const active = candidate.slices.find(s => s.status === 'running');
      if (active && !plan.dependencies.includes(active.id)) plan.dependencies.push(active.id);
      const valid = plan.decisionKeys.every(key => candidate.intent.decisions.some(d => d.key === key && d.status === 'active' && d.kind !== 'tentative'));
      const dependenciesExist = plan.dependencies.every(id => candidate.slices.some(s => s.id === id));
      if (!dependenciesExist) throw new Error('Next slice refers to an unknown dependency.');
      const unresolved = candidate.intent.decisions.some(d => d.status === 'conflict' && plan.decisionKeys.includes(d.key));
      if (plan.ready && (!plan.requirements.length || !valid || unresolved)) throw new Error('A ready slice needs requirements and settled, conflict-free decision references.');
      // Replace only the single future slot. Preserve prior briefs as cancelled history.
      for (const s of candidate.slices) if (['ready', 'draft', 'reconcile', 'blocked', 'cancelled'].includes(s.status)) s.status = 'cancelled';
      candidate.slices.push({ id: randomUUID(), plan, status: plan.ready ? 'ready' : 'draft' });
    }
    // Keep the running object identity: its completion callback still owns it.
    candidate.slices = candidate.slices.map(s => this.state.slices.find(old => old.id === s.id && old.status === 'running') ?? s);
    Object.assign(this.state, candidate);
    this.recordIntent('Companion translated human thinking');
  }
  private recordIntent(reason: string): void {
    this.state.intent.revision++;
    this.state.history.push({ timestamp: Date.now(), reason, intent: structuredClone(this.state.intent) });
  }
  private schedule(): void {
    if (this.closing) return;
    if (this.needsReconciliation && !this.conversationTask) {
      this.needsReconciliation = false;
      this.notice({ role: 'system', text: 'The Companion is reconciling a changed implementation assumption with your existing intent.' });
      void this.converse('', false);
    }
    if (this.closing || this.buildTask || this.state.mode !== 'running' || !this.state.remainingSlices) return;
    const slice = this.state.slices.find(s => s.status === 'ready' && s.plan.dependencies.every(id =>
      this.state.slices.some(d => d.id === id && d.status === 'completed')));
    if (!slice) return;
    if (slice.plan.decisionKeys.some(key => !this.state.intent.decisions.some(d => d.key === key && d.kind !== 'tentative' && d.status === 'active'))) {
      slice.status = 'reconcile'; this.persist(); return;
    }
    slice.snapshot = structuredClone({ intent: this.state.intent, requirements: slice.plan.requirements, goal: slice.plan.goal });
    slice.status = 'running'; this.state.remainingSlices--; this.persist();
    const controller = new AbortController(); this.buildAbort = controller;
    this.notice({ role: 'builder', text: `Building: ${slice.plan.title}` });
    this.buildTask = (async () => {
      try {
        const result = validate(BuilderSchema, await this.agents.build(structuredClone(slice), controller.signal, event => {
          this.store.event({ sliceId: slice.id, event });
          if (typeof event === 'string') this.notice({ role: 'builder', text: event });
        }));
        if (controller.signal.aborted) { slice.status = 'interrupted'; return; }
        slice.result = result; slice.status = result.status;
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
        this.notice({ role: 'builder', text: `${slice.status}: ${errorText(error)}` });
      } finally {
        this.buildTask = undefined; this.buildAbort = undefined; this.persist();
        if (!this.state.remainingSlices) this.notice({ role: 'system', text: 'Four-slice session limit reached. /resume continues when you want.' });
        this.schedule();
      }
    })();
  }
  private persist(): void { this.state.revision++; this.store.save(this.state); }
}
export function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
