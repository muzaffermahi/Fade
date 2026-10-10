import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Coordinator, errorText, type Agents, type Notice } from './coordinator.js';
import type { ProjectState } from './contracts.js';
import { Store, renderIntent } from './store.js';
import { PiAgents, type PiOptions } from './pi.js';
import { builderReport, reports, executionLog } from './reports.js';

export type AgentFactory = (store: Store, state: ProjectState, options: PiOptions, nativeConversation?: Agents['converse']) => Agents;
/** Owns Fade's durable project loop alongside the native Pi conversation. */
export class FadeApp {
  coordinator: Coordinator | undefined;
  private queued: Promise<void> = Promise.resolve();
  private closed = false;
  private pending = 0;
  private speaking = false;
  constructor(readonly store: Store, readonly options: PiOptions, private readonly show: (notice: Notice) => void,
    private readonly status: (value: string) => void = () => {}, private readonly factory: AgentFactory = (s, state, o) => new PiAgents(s, state, o)) {
    const state = store.load();
    if (state) {
      this.coordinator = new Coordinator(state, store, factory(store, state, options), show);
      this.coordinator.recover();
    }
  }
  get busy(): boolean { return this.speaking || Boolean(this.coordinator?.isConversing) || Boolean(this.coordinator?.state.slices.some(s => s.status === 'running')); }
  /** Normal Pi submissions automatically enter the Fade loop, in submission order. */
  submit(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error('Fade is closing.'));
    if (!text.trim()) return Promise.resolve();
    const initial = !this.coordinator;
    if (!this.coordinator) {
      const state = Coordinator.initial(this.store.workspace, text);
      this.coordinator = new Coordinator(state, this.store, this.factory(this.store, state, this.options), this.show);
      this.store.save(state);
    }
    const coordinator = this.coordinator;
    const sourceId = coordinator.accept(text);
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
    this.queued = task.catch(error => this.show({ role: 'system', text: errorText(error) })).finally(() => { this.pending--; this.updateStatus(); });
    return this.queued;
  }
  history(): { role: 'human' | 'companion'; text: string }[] { return this.coordinator?.state.conversation ?? []; }
  async command(name: string, args: string): Promise<void> {
    const c = this.coordinator;
    if (!c) { this.show({ role: 'system', text: 'Start with a regular prompt describing what you want to create.' }); return; }
    switch (name) {
      case 'pause': await c.pause(); break;
      case 'stop': await c.pause(true); break;
      case 'continue': c.resume(); break;
      case 'builder':
        if (args.trim()) await c.messageBuilder(args.trim());
        else this.show({ role: 'system', text: builderReport(c.state) });
        break;
      case 'companion':
        if (args.trim()) await this.submit(args.trim());
        else this.show({ role: 'system', text: c.state.conversation.filter(m => m.role === 'companion').at(-1)?.text ?? 'Write a regular prompt to talk with the Companion.' });
        break;
      case 'reports': this.show({ role: 'system', text: reports(c.state) }); break;
      case 'status': this.show({ role: 'system', text: `${c.state.mode}; ${c.state.remainingSlices} slices left\n\n` + c.state.slices.slice(-8).map(s => `${s.status} · ${s.plan.title}\n${s.result?.summary ?? s.plan.goal}`).join('\n\n') }); break;
      case 'intent': this.show({ role: 'system', text: renderIntent(c.state) + `\nEdit ${this.store.prepareIntentEdit(c.state)}, then /apply-intent.` }); break;
      case 'apply-intent': c.editIntent(this.store.readIntent()); break;
      case 'rethink': await this.submit('Reconcile our latest intent, conversation, and implementation discoveries. Preserve what I have said; develop the next useful slice only if it is sufficiently clear.'); break;
      case 'redirect':
        if (!args.trim()) throw new Error('Write the new direction after /redirect.');
        await this.interrupt(); await this.queued;
        await c.redirect(args); break;
      case 'history': for (const message of c.state.conversation) this.show({ role: message.role === 'human' ? 'system' : 'companion', text: message.text }); break;
      case 'log': {
        let log = 'No Builder events yet.';
        try { log = executionLog(readFileSync(join(this.store.directory, 'builder-events.jsonl'), 'utf8')); } catch { /* Empty log is normal. */ }
        this.show({ role: 'system', text: log }); break;
      }
      case 'preference':
        if (args !== 'design' && args !== 'technical') throw new Error('Use /preference design or technical.');
        c.state.preference = args; this.store.save(c.state); this.show({ role: 'system', text: `Conversation preference: ${args}` }); break;
    }
  }
  async interrupt(): Promise<void> { await this.coordinator?.interrupt(); }
  async idle(): Promise<void> { await this.queued; await this.coordinator?.idle(); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.coordinator) await this.coordinator.close(); else this.store.close();
    await this.queued;
  }
  private updateStatus(): void {
    this.status(this.speaking ? `Companion thinking${this.pending > 1 ? ` · ${this.pending - 1} queued` : ''}` : this.pending ? `${this.pending} thoughts queued` : 'Companion ready');
  }
}
