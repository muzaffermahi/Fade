// The recap card: what a session (or a finished goal) shipped. Shown in Fade, and printed on quit so it
// stays in your scrollback, ready to screenshot.
import type { FadeView } from '../view.js';
import { box } from './box.js';
import { compactMark } from './logo.js';
import { bold, c, GLYPH, sanitize } from './theme.js';

export interface RecapInput {
  title: string;
  goal: string;
  shipped: string[];
  startedAt: number;
  commits?: number;
  quiet?: number;
  idleMs?: number;
  /** A key hint under the card, when it's shown inside Fade. */
  footer?: string;
}

const MAX_LISTED = 8;

/** "2h14m", "14m", "40s". */
export function duration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

function statsLine(input: RecapInput, now: number): string {
  const parts = [
    `shipped ${input.shipped.length} step${input.shipped.length === 1 ? '' : 's'}`,
    duration(now - input.startedAt),
  ];
  if (input.commits !== undefined) parts.push(`${input.commits} commit${input.commits === 1 ? '' : 's'}`);
  if (input.idleMs !== undefined) {
    parts.push(input.idleMs < 60_000 ? 'the Builder never waited on you' : `Builder idle ${duration(input.idleMs)}`);
  }
  return parts.join(c.faint(' · '));
}

export function recapLines(input: RecapInput, width: number, now = Date.now()): string[] {
  const lines = [compactMark(), ''];
  if (input.goal) lines.push(`${c.mint('◎')} ${c.text(sanitize(input.goal))}`, '');
  lines.push(c.text(statsLine(input, now)), '');
  if (input.quiet) lines.push(c.muted(`verified quietly: ${input.quiet}`), '');
  for (const title of input.shipped.slice(0, MAX_LISTED)) lines.push(`${c.mint(GLYPH.done)} ${c.text(sanitize(title))}`);
  if (input.shipped.length > MAX_LISTED) lines.push(c.muted(`  +${input.shipped.length - MAX_LISTED} more`));
  lines.push('', `${bold(c.mint('fade'))} ${c.muted('· get your flow back')}`);
  if (input.footer) lines.push('', c.muted(input.footer));
  return box(input.title, lines, width);
}

/** Recap numbers for the current run of Fade. */
export function recapInput(view: FadeView, title: string): RecapInput {
  return {
    title, goal: view.goal, shipped: view.session.shipped, startedAt: view.session.startedAt,
    quiet: view.session.quiet ?? 0, commits: view.session.commits, idleMs: view.session.idleMs,
  };
}
