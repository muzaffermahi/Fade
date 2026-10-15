import type { SlashCommand } from '@earendil-works/pi-tui';

export type CardState = 'draft' | 'ready' | 'building' | 'review';
export interface Card {
  title: string;
  state: CardState;
  body: string;
}
export interface DoneEntry {
  title: string;
  sha?: string;
}
export interface Plan {
  preamble: string;
  /** The one thread everything serves right now ("Goal: …" in PLAN.md). Empty when unset. */
  goal: string;
  cards: Card[];
  /** Parked one-liners that don't belong to the current goal ("## Later"). */
  later: string[];
  done: DoneEntry[];
}

export interface Step {
  text: string;
  status: 'done' | 'active' | 'todo';
}

/** One agreed criterion, its Builder claim, and any proof captured by Fade. */
export interface Check {
  criterion: string;
  passed: boolean;
  evidence?: string;
  proof?: string;
  look?: string;
  /** Captured by Fade, never supplied by the Builder. */
  ran?: { code: number; tail: string; ms: number; sha?: string };
}

export type BuildOutcome =
  | { kind: 'done'; summary: string; howToTry: string; tryCommand?: string; checks?: Check[] }
  | { kind: 'unfinished'; summary: string }
  | { kind: 'stuck'; question: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string };

export type BuilderEvent =
  | { type: 'understood'; outcome: string; assumptions?: string[]; doneWhen: string[] }
  | { type: 'steps'; steps: Step[] }
  | { type: 'action'; text: string } // e.g. "editing src/search.ts"
  | { type: 'text'; text: string } // full text of the assistant message being streamed
  | { type: 'message'; text: string } // a finished assistant message
  | { type: 'log'; line: string }; // raw tool line for the Ctrl+L view

export type CompanionEvent =
  | { type: 'text'; text: string } // full streamed text of the current reply
  | { type: 'message'; text: string } // final reply
  | { type: 'card'; title: string; action: 'added' | 'edited' }
  | { type: 'goal'; text: string }
  | { type: 'parked'; text: string }
  | { type: 'tool'; text: string } // e.g. "reading src/app.ts"
  | { type: 'error'; text: string };

/** What a slash command asks the UI to do next. */
export type SlashResult =
  | { kind: 'toast'; text: string; model?: string; newSession?: boolean }
  | { kind: 'info'; text: string }
  | { kind: 'prompt'; text: string } // send the raw text to the agent (skills, prompt templates)
  | { kind: 'pick-model'; models: string[]; current: string }
  /** Open Pi's own screen on this agent's session; `reopen` reloads the session afterwards. */
  | { kind: 'handoff'; command: string; args: string[]; reopen: () => Promise<void> };

/** Pi's slash commands for one agent's session. */
export interface SlashHost {
  commands(): SlashCommand[];
  run(text: string): Promise<SlashResult>;
  /** Switches this agent's model; used by the /model picker. */
  setModel(selector: string): Promise<SlashResult>;
}

export interface BuilderAgent {
  readonly busy: boolean;
  readonly slash?: SlashHost;
  /** Create the Pi session; throws a human-readable error on failure. */
  init(): Promise<void>;
  build(card: Card, context: string, onEvent: (e: BuilderEvent) => void): Promise<BuildOutcome>;
  /** Steer the current build. */
  note(text: string): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface PlanApi {
  list(): Card[];
  /** Returns the final unique title. */
  addCard(title: string, body: string): string;
  editCard(title: string, patch: { title?: string; body?: string }): void;
  goal(): string;
  setGoal(text: string): void;
  later(): string[];
  park(text: string): void;
  /** Turns a parked Later item into a draft card; returns the card's title. */
  promote(item: string, title: string, body: string): string;
}

export interface CompanionAgent {
  readonly busy: boolean;
  readonly slash?: SlashHost;
  init(): Promise<void>;
  send(text: string, context: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface Review {
  verdict: 'verified' | 'look' | 'failed' | 'said' | 'unfinished' | 'none';
  title: string;
  summary: string;
  howToTry: string;
  /** A finite command that shows the work, run with `t`. */
  tryCommand?: string;
  /** The card's "Done when" lines, as written when it was built. */
  doneWhen?: string[];
  /** The Builder's verdict on each "Done when" line. */
  checks?: Check[];
  /** Set when the Builder got stuck. */
  question?: string;
  /** Checkpoint commit, if one was made. */
  sha?: string;
  /** Changed files in that commit. */
  files: string[];
  finishedAt: number;
}

export interface TranscriptEntry {
  role: 'you' | 'companion' | 'card' | 'goal' | 'parked' | 'tool' | 'error';
  text: string;
}
