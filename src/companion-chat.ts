import type { StateStore } from './state.js';
import type { CompanionAgent, CompanionEvent, TranscriptEntry } from './types.js';

/** The human's conversation with the Companion: transcript, streaming text, and errors. */
export class CompanionChat {
  live: string | undefined;

  constructor(
    private readonly companion: CompanionAgent,
    private readonly state: StateStore,
    private readonly notify: () => void,
    private readonly contextNow: () => string,
  ) {}

  get busy(): boolean {
    return this.companion.busy;
  }

  private push(entry: TranscriptEntry): void {
    this.state.data.companion.push(entry);
    try {
      this.state.save();
    } catch {
      // Losing transcript history is not worth interrupting the human.
    }
  }

  send(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    this.push({ role: 'you', text: clean });
    const context = this.contextNow();
    this.notify();
    void this.run(clean, context);
  }

  private async run(text: string, context: string): Promise<void> {
    try {
      await this.companion.send(text, context, e => this.onEvent(e));
    } catch (error) {
      this.onEvent({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
    this.live = undefined;
    this.notify();
  }

  private onEvent(event: CompanionEvent): void {
    if (event.type === 'text') this.live = event.text;
    if (event.type === 'message') {
      this.live = undefined;
      if (event.text.trim()) this.push({ role: 'companion', text: event.text });
    }
    if (event.type === 'card') {
      this.push({ role: 'card', text: `${event.title}  ${event.action === 'added' ? '(draft)' : '(edited)'}` });
    }
    if (event.type === 'tool') this.push({ role: 'tool', text: event.text });
    if (event.type === 'error') this.push({ role: 'error', text: `Companion: ${event.text}` });
    this.notify();
  }

  /** Forgets the transcript, for /new. */
  clear(): void {
    this.state.data.companion = [];
    this.live = undefined;
    try {
      this.state.save();
    } catch {
      // Same as push: not worth interrupting the human.
    }
    this.notify();
  }

  stop(): Promise<void> {
    return this.companion.stop();
  }
}
