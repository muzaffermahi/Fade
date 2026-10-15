import type { StateStore } from './state.js';
import type { CompanionAgent, CompanionEvent, TranscriptEntry } from './types.js';

const READ_BACK = /^(?:on it\b|queued\b|that'?s (?:underway|in motion)\b|option \d+ it is\b)/i;

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

  reply(text: string): void {
    if (text.startsWith('On it:')) {
      // The first build in a project is the moment to teach the one idea: you never have to wait.
      const first = !this.state.data.companion.some((entry) => entry.text.startsWith('On it:'));
      if (first) text = `${text} The Builder is on it now; keep talking to me while it builds.`;
      const start = this.state.data.companion.findLastIndex((entry) => entry.role === 'you');
      this.state.data.companion = this.state.data.companion.filter(
        (entry, index) => index <= start || entry.role !== 'companion' || !READ_BACK.test(entry.text),
      );
      this.live = undefined;
    }
    this.push({ role: 'landed', text });
    this.notify();
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
      await this.companion.send(text, context, (e) => this.onEvent(e));
    } catch (error) {
      this.onEvent({ type: 'error', text: error instanceof Error ? error.message : String(error) });
    }
    // A follow-up message returns right away while the first reply still streams: keep showing it.
    if (!this.companion.busy) this.live = undefined;
    this.notify();
  }

  private onEvent(event: CompanionEvent): void {
    const turn = this.state.data.companion.slice(
      this.state.data.companion.findLastIndex((entry) => entry.role === 'you') + 1,
    );
    if (
      (event.type === 'text' || event.type === 'message') &&
      READ_BACK.test(event.text) &&
      turn.some((entry) => entry.role === 'landed' && entry.text.startsWith('On it:'))
    ) {
      this.live = undefined;
      return;
    }
    if (event.type === 'text') this.live = event.text;
    if (event.type === 'message') {
      this.live = undefined;
      if (event.text.trim()) this.push({ role: 'companion', text: event.text });
    }
    if (event.type === 'tool') this.push({ role: 'tool', text: event.text });
    if (event.type === 'error') this.push({ role: 'error', text: `Fade couldn't reply: ${event.text}` });
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
