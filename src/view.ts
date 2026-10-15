import { matchChecks, verdict } from './verdict.js';
import { doneWhenLines } from './plan.js';
import type { BuilderEvent, BuildOutcome, Card, DoneEntry, Review, Step, TranscriptEntry } from './types.js';

export interface BuildingView {
  title: string;
  steps: Step[];
  action: string;
  startedAt: number;
  liveText: string;
  lastMessage: string;
  notes: string[];
}

/** What this run of Fade has done so far: progress recorded during this session. */
export interface SessionStats {
  startedAt: number;
  shipped: string[];
  quiet?: number;
  commits: number;
  /** Time the Builder sat with nothing to do, after the first card started. */
  idleMs: number;
}

export interface FadeView {
  cards: Card[];
  later: string[];
  done: DoneEntry[];
  reviews: Review[];
  landedReviews: Review[];
  building: BuildingView | null;
  builderLog: string[];
  builderError?: string;
  companion: TranscriptEntry[];
  companionLive?: string;
  companionBusy: boolean;
  shippedToday: number;
  lastQuiet?: DoneEntry;
  session: SessionStats;
  showTitle?: string;
  toast?: string;
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

/** Outcome copy never includes shell commands; Show retains the complete proof. */
export function landingMessage(review: Review, retried = false): string {
  const name = review.title.replace(/\s+/g, ' ').trim();
  const prose = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, 180);
  if (review.question) return `◆ ${name} needs your answer: ${prose(review.question)}`;
  if (review.verdict === 'unfinished') return `◌ ${name} is unfinished. Say "continue" or tell me what to change.`;
  if (review.verdict === 'verified') {
    if (!review.sha) return `◆ ${name} passed its checks, but no checkpoint was saved. Ask to see the result.`;
    const plain = review.checks?.filter(c => c.ran?.code === 0).map(c => prose(c.criterion))
      .filter(text => !/[`{};]|(?:node|python[\d.]?|pytest|npm|npx|git|cargo|go test)\s|\b(?:exec|require)\(/i.test(text));
    const detail = plain?.[0]?.replace(/[.!]$/, '');
    return detail ? `✓ ${name} — ${detail} (checked).` : `✓ ${name} is done (checks passed).`;
  }
  if (review.verdict === 'failed') {
    return `✗ ${name} didn't pass its checks. ${retried ? 'Sent it back once.' : 'Ask to see the checks or tell me what to change.'}`;
  }
  if (review.verdict === 'look') {
    const questions = review.checks?.filter(c => c.look).map(c => c.look).join(' ') ?? '';
    return `◆ ${name} is built. Your call: ${prose(questions)}`;
  }
  const missing = review.checks?.filter(c => !c.ran && !c.look).map(c => prose(c.criterion).replace(/[.!]+$/, '')).join('; ');
  return `◆ ${name} is built, but I couldn't check ${missing || 'the result'}. Ask to see the details.`;
}
