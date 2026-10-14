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
  cards: Card[];
  done: DoneEntry[];
}

export interface Step {
  text: string;
  status: 'done' | 'active' | 'todo';
}

export type BuildOutcome =
  | { kind: 'done'; summary: string; howToTry: string }
  | { kind: 'stuck'; question: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string };

export type BuilderEvent =
  | { type: 'steps'; steps: Step[] }
  | { type: 'action'; text: string } // e.g. "editing src/search.ts"
  | { type: 'text'; text: string } // full text of the assistant message being streamed
  | { type: 'message'; text: string } // a finished assistant message
  | { type: 'log'; line: string }; // raw tool line for the Ctrl+L view

export type CompanionEvent =
  | { type: 'text'; text: string } // full streamed text of the current reply
  | { type: 'message'; text: string } // final reply
  | { type: 'card'; title: string; action: 'added' | 'edited' }
  | { type: 'tool'; text: string } // e.g. "reading src/app.ts"
  | { type: 'error'; text: string };

export interface BuilderAgent {
  readonly busy: boolean;
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
}

export interface CompanionAgent {
  readonly busy: boolean;
  init(): Promise<void>;
  send(text: string, context: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface Review {
  title: string;
  summary: string;
  howToTry: string;
  /** Set when the Builder got stuck. */
  question?: string;
  /** Checkpoint commit, if one was made. */
  sha?: string;
  /** Changed files in that commit. */
  files: string[];
  finishedAt: number;
}

export interface TranscriptEntry {
  role: 'you' | 'companion' | 'card' | 'tool' | 'error';
  text: string;
}
