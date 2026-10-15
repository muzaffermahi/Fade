// The attention model: how much think-time you have (runway), and the ONE thing worth your attention next.
// Pure functions over plain data, so the ranking is easy to test and reason about.
import type { Card, Review } from './types.js';

/** Until we have history, assume a card takes about six minutes. */
export const DEFAULT_CARD_MS = 6 * 60_000;
/** Below this, the Builder is about to run out of work. */
export const LOW_RUNWAY_MS = 5 * 60_000;
const RECENT = 5;

/** Median of the last few build durations, or the default when there's no history. */
export function typicalCardMs(durations: readonly number[]): number {
  const recent = durations.slice(-RECENT).filter(ms => ms > 0).sort((a, b) => a - b);
  if (recent.length === 0) return DEFAULT_CARD_MS;
  const mid = Math.floor(recent.length / 2);
  const median = recent.length % 2 === 1 ? recent[mid] ?? DEFAULT_CARD_MS
    : ((recent[mid - 1] ?? 0) + (recent[mid] ?? 0)) / 2;
  return Math.max(30_000, median);
}

export interface RunwayInput {
  cards: readonly Card[];
  /** When the current card started, or null if the Builder is idle. */
  buildingSince: number | null;
  durations: readonly number[];
  now: number;
}

/** Estimated time until the Builder runs out of ready work: what's left of this card, plus every ready card. */
export function runwayMs(input: RunwayInput): number {
  const typical = typicalCardMs(input.durations);
  const ready = input.cards.filter(card => card.state === 'ready').length;
  // A card running longer than usual still has *some* time left: never claim under a minute while it works.
  const current = input.buildingSince === null ? 0 : Math.max(60_000, typical - (input.now - input.buildingSince));
  return current + ready * typical;
}

/** "~12m", "~45s", "~1h20m". */
export function formatRunway(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (ms < 60_000) return `~${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `~${minutes}m`;
  return `~${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

export type NextItem =
  | { kind: 'stuck'; review: Review }
  | { kind: 'fresh'; title: string } // the Companion just proposed this step; ready it?
  | { kind: 'review'; review: Review; more: number }
  | { kind: 'idle'; draft?: string } // the Builder has nothing to do
  | { kind: 'low'; draft?: string; runwayMs: number } // the Builder is about to have nothing to do
  | { kind: 'calm' };

export interface NextInput {
  cards: readonly Card[];
  reviews: readonly Review[];
  building: boolean;
  runwayMs: number;
  freshDraft?: string;
}

/**
 * Ranked by what keeps you on one thread and the Builder fed:
 * a question the Builder is blocked on, the step you were just discussing, the step that just landed,
 * then an idle or starving Builder. Otherwise: nothing. Calm is a valid answer.
 */
export function nextItem(input: NextInput): NextItem {
  const stuck = input.reviews.find(review => review.question);
  if (stuck) return { kind: 'stuck', review: stuck };
  const fresh = input.freshDraft && input.cards.find(card => card.title === input.freshDraft && card.state === 'draft');
  if (fresh) return { kind: 'fresh', title: fresh.title };
  const review = input.reviews[0];
  if (review) return { kind: 'review', review, more: input.reviews.length - 1 };
  const hasReady = input.cards.some(card => card.state === 'ready');
  const draft = input.cards.find(card => card.state === 'draft')?.title;
  const withDraft = <T extends object>(item: T): T & { draft?: string } => (draft ? { ...item, draft } : item);
  if (!input.building && !hasReady) return withDraft({ kind: 'idle' as const });
  if (input.building && !hasReady && input.runwayMs < LOW_RUNWAY_MS) {
    return withDraft({ kind: 'low' as const, runwayMs: input.runwayMs });
  }
  return { kind: 'calm' };
}

/** A stable identity, so the UI can tell "the same thing is still next" from "something new arrived". */
export function itemKey(item: NextItem): string {
  switch (item.kind) {
    case 'stuck': return `stuck:${item.review.title}`;
    case 'fresh': return `fresh:${item.title}`;
    case 'review': return `review:${item.review.title}`;
    case 'idle': return `idle:${item.draft ?? ''}`;
    case 'low': return `low:${item.draft ?? ''}`;
    case 'calm': return 'calm';
  }
}

/** Items that deserve a (quiet) signal when they appear: the Builder is blocked, done, or starving. */
export function wantsSignal(item: NextItem): boolean {
  return item.kind === 'stuck' || item.kind === 'review' || item.kind === 'idle';
}
