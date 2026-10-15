import { matchChecks, verdict } from './verdict.js';
import { doneWhenLines } from './plan.js';
import type { BuilderEvent, BuildOutcome, Card, DoneEntry, Review, Step, TranscriptEntry } from './types.js';

export interface BuildingView {
  title: string;
  understood?: string;
  steps: Step[];
  action: string;
  startedAt: number;
  liveText: string;
  lastMessage: string;
  notes: string[];
}

/** What this run of Fade has done so far: the raw material for the recap card. */
export interface SessionStats {
  startedAt: number;
  shipped: string[];
  quiet?: number;
  commits: number;
  /** Time the Builder sat with nothing to do, after the first card started. */
  idleMs: number;
}

export interface GoalComplete {
  goal: string;
  steps: string[];
  startedAt: number;
}

export interface FadeView {
  goal: string;
  cards: Card[];
  later: string[];
  done: DoneEntry[];
  reviews: Review[];
  building: BuildingView | null;
  builderLog: string[];
  builderError?: string;
  companion: TranscriptEntry[];
  companionLive?: string;
  companionBusy: boolean;
  shippedToday: number;
  lastQuiet?: DoneEntry;
  /** Steps finished under the current goal, and steps in it overall. */
  progress: { done: number; total: number };
  /** Estimated think-time before the Builder runs out of ready work. */
  runwayMs: number;
  /** A draft the Companion just proposed and you haven't readied or moved past yet. */
  freshDraft?: string;
  /** Set once every step of the goal has shipped, until you start the next goal. */
  goalComplete?: GoalComplete;
  session: SessionStats;
  bell: boolean;
  toast?: string;
}

export function titleFromText(text: string): string {
  const line = (text.split('\n').find(l => l.trim()) ?? 'Task').trim();
  if (line.length <= 48) return line;
  const cut = line.slice(0, 48);
  const space = cut.lastIndexOf(' ');
  return (space > 20 ? cut.slice(0, space) : cut).trim();
}

export function applyBuilderEvent(building: BuildingView, event: BuilderEvent): void {
  if (event.type === 'steps') building.steps = event.steps;
  if (event.type === 'action') building.action = event.text;
  if (event.type === 'text') building.liveText = event.text;
  if (event.type === 'message') {
    building.lastMessage = event.text;
    building.liveText = '';
  }
}

const TOAST_MS = 3000;

/** A short message that clears itself after a few seconds. */
export class Toast {
  text: string | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly onChange: () => void) {}

  show(text: string): void {
    this.text = text;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.text = undefined;
      this.onChange();
    }, TOAST_MS);
    this.timer.unref();
    this.onChange();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}

/** The review record for a card the Builder finished (or got stuck on). */
export function makeReview(card: Card, outcome: BuildOutcome, saved: { sha?: string; files: string[] }): Review {
  const review: Review = {
    title: card.title,
    verdict: outcome.kind === 'unfinished' ? 'unfinished' : 'none',
    summary: outcome.kind === 'done' || outcome.kind === 'unfinished' ? outcome.summary : 'The Builder needs your answer.',
    howToTry: outcome.kind === 'done' ? outcome.howToTry : '',
    files: saved.files,
    finishedAt: Date.now(),
  };
  const doneWhen = doneWhenLines(card.body);
  if (doneWhen.length > 0) review.doneWhen = doneWhen;
  if (outcome.kind === 'done' && outcome.tryCommand?.trim()) review.tryCommand = outcome.tryCommand.trim();
  if (outcome.kind === 'stuck') review.question = outcome.question;
  if (outcome.kind === 'done') {
    review.checks = matchChecks(doneWhen, outcome.checks ?? []);
    review.verdict = verdict(doneWhen, review.checks);
  }
  if (saved.sha) review.sha = saved.sha;
  return review;
}
