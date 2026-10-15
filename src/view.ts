import { matchChecks, verdict } from './verdict.js';
import { doneWhenLines } from './plan.js';
import type { BuildOutcome, Card, DoneEntry, Review, Step, TranscriptEntry } from './types.js';

export interface BuildingView {
  title: string;
  steps: Step[];
  action: string;
  startedAt: number;
}

export interface FadeView {
  cards: Card[];
  later: string[];
  done: DoneEntry[];
  reviews: Review[];
  landedReviews: Review[];
  building: BuildingView | null;
  builderError?: string;
  companion: TranscriptEntry[];
  companionLive?: string;
  companionBusy: boolean;
  showTitle?: string;
}

/** The review record for a card the Builder finished (or got stuck on). */
export function makeReview(card: Card, outcome: BuildOutcome, saved: { sha?: string; files: string[] }): Review {
  const review: Review = {
    title: card.title,
    verdict: outcome.kind === 'unfinished' ? 'unfinished' : 'none',
    summary: outcome.kind === 'done' || outcome.kind === 'unfinished' ? outcome.summary : 'I need your answer.',
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
  if (review.verdict === 'unfinished') {
    return `○ ${name} — not checked: ${prose(review.summary) || 'work stopped early'}. Say "continue".`;
  }
  if (review.verdict === 'verified') {
    if (!review.sha) return `○ ${name} — not checked: no checkpoint was saved. Ask to see the result.`;
    if (name.startsWith('Undo: ')) return `↩ ${name.slice(6)} is undone.`;
    const plain = review.checks
      ?.filter((c) => c.ran?.code === 0)
      .map((c) => prose(c.criterion))
      .filter(
        (text) => !/[`{};]|(?:node|python[\d.]?|pytest|npm|npx|git|cargo|go test)\s|\b(?:exec|require)\(/i.test(text),
      );
    const detail = plain?.[0]?.replace(/[.!]$/, '');
    return detail ? `✓ ${name} — ${detail} · checked` : `✓ ${name} — done · checked`;
  }
  if (review.verdict === 'failed') {
    const next = retried ? 'Sent it back once.' : 'Say "show me" to see why, or tell me what to change.';
    return `✗ ${name} didn't pass its checks. ${next}`;
  }
  if (review.verdict === 'look') {
    const questions =
      review.checks
        ?.filter((c) => c.look && !c.ran)
        .map((c) => c.look)
        .join(' ') ?? '';
    return `◆ ${name} is built. Your call: ${prose(questions)}`;
  }
  const missing = review.checks
    ?.filter((c) => !c.ran && !c.look)
    .map((c) => prose(c.criterion).replace(/[.!]+$/, ''))
    .join('; ');
  return `○ ${name} — not checked: ${missing || 'no checks were agreed'}. Say "show me" to see why.`;
}
