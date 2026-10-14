import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Coordinator, errorText, type Agents, type Notice } from './coordinator.js';
import { validate, RunLimitSchema, StateSchema, sessionConversation, type ProjectState, type InputReceipt, type FadeNotification } from './contracts.js';
import { Store, renderIntent } from './store.js';
import { validateSendText } from './payloads.js';
import { PiAgents, type PiOptions } from './pi.js';
import { builderReport, reports, executionLog, toolActivity, observedOutput } from './reports.js';
import { projectWork } from './projection.js';
import { commandHelp, FADE_COMMANDS } from './commands.js';
import { ActivityTracker, activityLine } from './activity.js';
import { NotificationCenter, notification, notificationText } from './notifications.js';
import { diagnosticReport, diagnosticJson, doctorText, exportDiagnostic, type DiagnosticRuntime } from './diagnostics.js';

export type AgentFactory = (store: Store, state: ProjectState, options: PiOptions, nativeConversation?: Agents['converse']) => Agents;
/** Owns Fade's durable project loop alongside the native Pi conversation. */
export class FadeApp {
  coordinator: Coordinator | undefined;
  readonly activity = new ActivityTracker();
  readonly notifications = new NotificationCenter();
  get currentSessionId(): string { return this.coordinator?.state.currentSessionId ?? this.sessionId ?? 'welcome'; }
  private emit(notice: Notice): void { if (notice.notification) this.notifications.add(notice.notification); this.show(notice); }
  /** A local/native/plain failure uses the same typed boundary as coordinator errors. */
  report(kind: FadeNotification['kind'], role: FadeNotification['role'], operationId: string, cause: string, actions: FadeNotification['actions'], receiptId?: string): void {
    const sessionId = this.coordinator?.state.inputs.find(input => input.id === receiptId)?.sessionId ?? this.currentSessionId;
    const item = notification({ kind, role, operationId, cause, actions, sessionId, timestamp: Date.now(), ...(receiptId ? { receiptId } : {}) });
    this.emit({ role: 'system', text: notificationText(item), notification: item });
  }
  private queued: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  private speaking = false;
  private sessionId: string | undefined;
  constructor(readonly store: Store, readonly options: PiOptions, private readonly show: (notice: Notice) => void,
    private readonly status: (value: string) => void = () => {}, private readonly factory: AgentFactory = (s, state, o) => new PiAgents(s, state, o),
    private readonly diagnosticRuntime: () => DiagnosticRuntime = () => ({ builderAuthConfigured: null, companionAuthConfigured: null })) {
    if (options.runLimit !== undefined) validate(RunLimitSchema, options.runLimit);
    const state = store.load();
    if (state) {
      if (options.runLimit !== undefined) state.runLimit = options.runLimit;
      this.coordinator = new Coordinator(state, store, factory(store, state, options), notice => this.emit(notice), this.activity);
      this.coordinator.recover();
    }
  }
  get busy(): boolean { return this.speaking || Boolean(this.coordinator?.isConversing) || Boolean(this.coordinator?.state.slices.some(s => s.status === 'running')); }
  /** Normal Pi submissions automatically enter the Fade loop, in submission order. */
  submit(text: string, metadata: Partial<Pick<InputReceipt, 'mode' | 'attachments' | 'role' | 'sessionId'>> = {}, accepted?: (receiptId: string) => void): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Fade is closing.'));
    if (!text.trim()) return Promise.resolve();
    validateSendText(text); this.store.validateNewImages(metadata.attachments ?? []);
    const initial = !this.coordinator;
    if (!this.coordinator) {
      const state = Coordinator.initial(this.store.workspace, text, 'design', this.options.runLimit ?? 4);
      if (this.sessionId) state.currentSessionId = this.sessionId;
      // A rejected first draft must not leave an invalid in-memory project behind.
      validate(StateSchema, state); this.store.save(state);
      this.coordinator = new Coordinator(state, this.store, this.factory(this.store, state, this.options), notice => this.emit(notice), this.activity);
    }
    const coordinator = this.coordinator;
    const sourceId = coordinator.accept(text, metadata);
    accepted?.(sourceId);
    return this.enqueue(coordinator, sourceId, initial);
  }
  private enqueue(coordinator: Coordinator, sourceId: string, initial = false): Promise<void> {
    coordinator.queueInput(sourceId);
    this.pending++; this.updateStatus();
    const task = this.queued.then(async () => {
      if (this.closed) return;
      this.speaking = true; this.updateStatus();
      try {
        if (initial) coordinator.start();
        await coordinator.waitForConversation();
        if (!this.closed) await coordinator.talkAccepted(sourceId);
      } finally { this.speaking = false; }
    });
    this.queued = task.catch(error => this.report('accepted_not_delivered', coordinator.state.inputs.find(input => input.id === sourceId)?.role ?? 'companion', sourceId,
      `${errorText(error)} Your input remains saved.`, ['inputs'], sourceId)).finally(() => { this.pending--; this.updateStatus(); });
    return this.queued;
  }
  async setSession(sessionId: string): Promise<void> {
    this.store.flushTerminal(this.currentSessionId);
    this.sessionId = sessionId; if (this.coordinator) await this.coordinator.switchSession(sessionId);
    if (!this.coordinator?.isConversing && this.activity.get('companion').sessionId !== sessionId) this.activity.reset('companion', sessionId);
    if (!this.coordinator?.state.slices.some(slice => slice.id === this.activity.get('builder').operationId) && this.activity.get('builder').sessionId !== sessionId) this.activity.reset('builder', sessionId);
  }
  history(sessionId = this.currentSessionId): { role: 'human' | 'companion'; text: string }[] { return this.coordinator ? sessionConversation(this.coordinator.state, sessionId) : []; }
  /** Read-only application queries are shared by native overlays and plain output. */
  inspect(name: string, args = ''): string {
    const state = this.coordinator?.state;
    if (name === 'doctor' || name === 'bug-report') {
      if (args.trim()) throw new Error(`/${name} preview takes no arguments; use /bug-report export [relative-path.json] for an explicit local export.`);
      const report = this.supportReport();
      return name === 'doctor' ? doctorText(report) : 'Preview only. Paths, content, identifiers and raw errors are excluded.\n/bug-report export [relative-path.json] creates a new local file; nothing is uploaded.\n\n' + diagnosticJson(report);
    }
    if (name === 'help') return commandHelp('split');
    if (name === 'status') { const p = projectWork(state); return `Now: ${p.now}\nNext: ${p.next}\n${p.needsYou ? `Needs you: ${p.needsYou}\n` : ''}Run: ${p.remaining} slices left; next run limit ${state?.runLimit ?? 4}\nCompanion: ${activityLine(this.activity.get('companion'))}\nBuilder: ${activityLine(this.activity.get('builder'))}\nUsage (latest observed session): Companion ${p.usage.companion}; Builder ${p.usage.builder}\nCost: unknown\nExecution owner: ${state?.ownership.owner ?? 'none'}\n${this.coordinator?.persistenceFailure ? `Storage failure: ${this.coordinator.persistenceFailure}\n` : ''}\n` + p.queues.map(i => `${i.id} · ${i.role}/${i.mode} · ${i.text}`).join('\n'); }
    if (!state) return 'Explore: What if we changed this?\nBuild: Implement a concrete change and run its checks.\nNo implementation is active.';
    if (name === 'builder') {
      const current = state.slices.find(s => s.status === 'running') ?? state.slices.at(-1);
      return builderReport(state) + '\n\nObserved activity:\n' + state.workEvents.filter(e => e.sliceId === current?.id).slice(-30)
        .map(e => `${e.sequence} · ${e.phase} · ${new Date(e.timestamp).toISOString()}\n${toolActivity(e.payload) || e.type}`).join('\n\n');
    }
    if (name === 'intent') return renderIntent(state);
    if (name === 'reports') return reports(state) + '\n\nObserved results (separate from claims):\n' + state.verificationEvidence.slice(-30).map(e => `${e.sliceId} · ${e.toolName} · ${e.isError ? 'failed' : 'finished'}\n${observedOutput(e.result)}`).join('\n\n');
    if (name === 'inputs') return state.inputs.slice(-50).map(i => `${i.id} · ${i.role} · ${i.mode} · ${i.status} · session ${i.sessionId}\n${i.text}${i.error ? `\n${i.error}` : ''}`).join('\n\n') || 'No input receipts.';
    if (name === 'changes') { const slice = args ? state.slices.find(s => s.id === args) : state.slices.at(-1); if (!slice) return 'No matching slice.'; return this.store.readChanges(slice.id); }
    if (name === 'log') { try { return executionLog(readFileSync(join(this.store.directory, 'builder-events.jsonl'), 'utf8')); } catch { return 'No Builder events yet.'; } }
    if (name === 'history') return state.conversation.map(m => `${m.scope === 'session' ? `Session ${m.sessionId}${m.receiptId ? ` · input ${m.receiptId}` : ''}` : `Project history · ${m.historyReason}`}\n${m.role}\n${m.text}`).join('\n\n');
    throw new Error('Unknown inspection command.');
  }
  async inspectAsync(name: string, args = ''): Promise<string> {
    if (!['log', 'history', 'inputs', 'reports'].includes(name)) return this.inspect(name, args);
    if (name === 'history' && /^metadata(?:\s|$)/.test(args)) {
      const rest = args.replace(/^metadata\s*/, ''), metadata = /^page:(\d+)\s*(.*)$/.exec(rest);
      return this.store.readMetadataPage(metadata ? metadata[2] ?? '' : rest, metadata ? Number(metadata[1]) : 0);
    }
    const match = /^page:(\d+)\s*(.*)$/.exec(args);
    if (name !== 'log') return this.store.readRecordPage(name === 'history' ? 'conversation' : name === 'inputs' ? 'inputs' : 'slices', match ? match[2] ?? '' : args, match ? Number(match[1]) : 0);
    return this.store.readLogPage(match ? match[2] ?? '' : args, match ? Number(match[1]) : 0);
  }
  async command(name: string, args: string, destination: { sessionId: string; accepted?: (receiptId: string) => void } = { sessionId: this.currentSessionId }): Promise<void> {
    const command = FADE_COMMANDS.find(item => item.name === name);
    if (!command) throw new Error(`Unknown command /${name}. Use /help for commands.`);
    if (!command.available) throw new Error(`/${name} is unavailable: ${command.disabledReason}`);
    if (name === 'bug-report' && args.trim()) {
      this.show({ role: 'system', text: await this.exportReport(args) }); return;
    }
    if (command.category === 'inspection' && name !== 'diagnostics' && !(name === 'builder' && args.trim())) {
      this.show({ role: 'system', text: await this.inspectAsync(name, args) }); return;
    }
    if (name === 'companion' && args.trim()) { await this.submit(args, { role: 'companion', sessionId: destination.sessionId }, destination.accepted); return; }
    if (name === 'builder' && args.trim() && !this.coordinator) { await this.submit(args, { role: 'builder', sessionId: destination.sessionId }, destination.accepted); return; }
    const c = this.coordinator;
    if (!c) { this.show({ role: 'system', text: 'Start with a regular prompt describing what you want to create.' }); return; }
    switch (name) {
      case 'inputs': this.show({ role: 'system', text: c.state.inputs.slice(-30).map(i => `${i.id} · ${i.role} · ${i.mode} · ${i.status} · session ${i.sessionId}\n${i.text}${i.error ? `\n${i.error}` : ''}`).join('\n\n') || 'No input receipts.' }); break;
      case 'retry-input': c.retryInput(args); if (c.state.inputs.find(i => i.id === args)?.role === 'companion') await this.enqueue(c, args); break;
      case 'cancel-input': await c.agents.refreshBuilderQueue?.(true); c.cancelInput(args); await c.agents.refreshBuilderQueue?.(); break;
      case 'edit-input': {
        const separator = args.indexOf(' ');
        if (separator < 0) throw new Error('Use /edit-input <receipt-id> <replacement text>.');
        await c.agents.refreshBuilderQueue?.(true); c.editInput(args.slice(0, separator), args.slice(separator + 1)); await c.agents.refreshBuilderQueue?.(); break;
      }
      case 'pause': await c.pause(); break;
      case 'stop': await c.pause(true); break;
      case 'continue': c.resume(); break;
      case 'accept-check': {
        const match = /^(\S+)\s+(\S+)\s+(pass|fail)\s+([\s\S]+)$/.exec(args.trim());
        if (!match) throw new Error('Use /accept-check <slice-id> <check-id> pass|fail <inspection evidence>. /builder shows check IDs.');
        c.recordManualCheck({ commandId: randomUUID(), expectedRevision: c.state.revision, sliceId: match[1], checkId: match[2], passed: match[3] === 'pass', evidence: match[4] }, destination.accepted); break;
      }
      case 'builder':
        if (args.trim()) await c.messageBuilder(args.trim(), { sessionId: destination.sessionId }, destination.accepted);
        else this.show({ role: 'system', text: builderReport(c.state) });
        break;
      case 'companion':
        if (args.trim()) await this.submit(args.trim());
        else this.show({ role: 'system', text: sessionConversation(c.state).filter(m => m.role === 'companion').at(-1)?.text ?? 'Write a regular prompt to talk with the Companion.' });
        break;
      case 'reports': this.show({ role: 'system', text: reports(c.state) }); break;
      case 'status': this.show({ role: 'system', text: `${c.state.mode}; ${c.state.remainingSlices} slices left\n\n` + c.state.slices.slice(-8).map(s => `${s.status} · ${s.plan.title}\n${s.result?.summary ?? s.plan.goal}`).join('\n\n') }); break;
      case 'intent': this.show({ role: 'system', text: renderIntent(c.state) + `\nEdit ${this.store.prepareIntentEdit(c.state)}, then /apply-intent.` }); break;
      case 'apply-intent': c.editIntent(this.store.readIntent()); break;
      case 'rethink': await this.submit('Reconcile our latest intent, conversation, and implementation discoveries. Preserve what I have said; develop the next useful slice only if it is sufficiently clear.', { sessionId: destination.sessionId }, destination.accepted); break;
      case 'redirect':
        if (!args.trim()) throw new Error('Write the new direction after /redirect.');
        await this.interrupt(); await this.queued;
        await c.redirect(args, destination.sessionId); break;
      case 'history': for (const message of c.state.conversation) this.show({ role: message.role === 'human' ? 'system' : 'companion', text: message.text }); break;
      case 'log': {
        let log = 'No Builder events yet.';
        try { log = executionLog(readFileSync(join(this.store.directory, 'builder-events.jsonl'), 'utf8')); } catch { /* Empty log is normal. */ }
        this.show({ role: 'system', text: log }); break;
      }
      case 'preference':
        { const preference = args.trim();
        if (preference !== 'design' && preference !== 'technical') throw new Error('Use /preference design or technical.');
        c.state.preference = preference; this.store.save(c.state); this.show({ role: 'system', text: `Conversation preference: ${preference}` }); break; }
      default: throw new Error(`/${name} requires its ${command.surfaces.join('/')} surface handler.`);
    }
  }
  async interrupt(): Promise<void> { await this.coordinator?.interrupt(); }
  /** Explicit human export quiesces implementation; presentation remains local to its caller. */
  async exportReport(args: string): Promise<string> {
    const match = /^export(?:\s+([\s\S]+))?$/.exec(args.trim()); if (!match) throw new Error('Use /bug-report to preview or /bug-report export [relative-path.json].');
    const report = this.supportReport(), write = async () => exportDiagnostic(this.store.workspace, match[1] ?? `fade-bug-report-${randomUUID()}.json`, report);
    const path = this.coordinator ? await this.coordinator.withCompanionExecution('human diagnostic export', write) : await write();
    return `Exported locally: ${path}\nNothing was uploaded.${this.coordinator ? ' Builder remains paused; /continue is explicit.' : ''}\n\n` + diagnosticJson(report);
  }
  async idle(): Promise<void> { await this.queued; await this.coordinator?.idle(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.store.flushTerminal();
    if (this.coordinator) await this.coordinator.close(); else this.store.close();
    await this.queued;
  }
  private updateStatus(): void {
    this.status(this.speaking ? `Companion thinking${this.pending > 1 ? ` · ${this.pending - 1} queued` : ''}` : this.pending ? `${this.pending} thoughts queued` : 'Companion ready');
  }
  private supportReport() { return diagnosticReport(this.coordinator?.state, this.options, Boolean(this.coordinator?.persistenceFailure), this.store.diagnostics.length, this.diagnosticRuntime()); }
}
