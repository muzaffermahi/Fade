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

export interface FadeView {
  cards: Card[];
  done: DoneEntry[];
  reviews: Review[];
  building: BuildingView | null;
  builderLog: string[];
  builderError?: string;
  companion: TranscriptEntry[];
  companionLive?: string;
  companionBusy: boolean;
  shippedToday: number;
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
export function makeReview(title: string, outcome: BuildOutcome, saved: { sha?: string; files: string[] }): Review {
  const review: Review = {
    title,
    summary: outcome.kind === 'done' ? outcome.summary : 'The Builder needs your answer.',
    howToTry: outcome.kind === 'done' ? outcome.howToTry : '',
    files: saved.files,
    finishedAt: Date.now(),
  };
  if (outcome.kind === 'stuck') review.question = outcome.question;
  if (saved.sha) review.sha = saved.sha;
  return review;
}
