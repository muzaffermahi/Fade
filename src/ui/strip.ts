import { visibleWidth } from '@earendil-works/pi-tui';
import { formatRunway, LOW_RUNWAY_MS, type NextItem } from '../flow.js';
import type { FadeView } from '../view.js';
import type { Card, Review } from '../types.js';
import { bold, c, GLYPH, sanitize, spread } from './theme.js';

export interface Fading {
  title: string;
  start: number;
  /** Where the card sat in the plan, so it dissolves in place. */
  index: number;
}

export const FADE_MS = 700;

const DUST = ['▓', '▒', '░', '·', ' '];
const MAX_DOTS = 10;

/** Right-to-left dissolve: ▓ ▒ ░ · while the color drifts ivory → mint → lavender → faint. */
export function dissolve(title: string, progress: number): string {
  const chars = [...sanitize(title)];
  const n = chars.length;
  const paint = progress < 0.25 ? c.text : progress < 0.5 ? c.mint : progress < 0.75 ? c.lavender : c.faint;
  const out = chars.map((ch, i) => {
    const age = progress * (n + 4) - (n - 1 - i);
    if (age <= 0) return ch;
    return DUST[Math.min(DUST.length - 1, Math.floor(age))] ?? ' ';
  });
  return paint(out.join(''));
}

function glyphFor(card: Card): string {
  return GLYPH[card.state];
}

function stateColor(card: Card): (s: string) => string {
  if (card.state === 'review') return c.lavender;
  if (card.state === 'draft') return c.faint;
  return c.mint;
}

function quoted(title: string): string {
  return c.text(`"${sanitize(title)}"`);
}

/** "●●○○○" for small goals, "3 of 12" when the dots would get long. */
function progressMarks(view: FadeView): string {
  const { done, total } = view.progress;
  if (total === 0) return '';
  if (total > MAX_DOTS) return c.muted(`${done} of ${total}`);
  return c.mint('●'.repeat(done)) + c.faint('○'.repeat(total - done)) + c.muted(`  ${done} of ${total}`);
}

/** The thread: the goal, how far along it is, how much think-time you have, and today's count. */
export function threadLine(view: FadeView, width: number): string {
  const goal = view.goal
    ? `${c.mint('◎')} ${c.text(sanitize(view.goal))}`
    : `${c.faint('◎')} ${c.faint('no goal yet · tell the Companion what you are making')}`;
  const marks = view.goal ? progressMarks(view) : '';
  const hasWork = view.building !== null || view.cards.some(card => card.state === 'ready');
  const runwayColor = view.runwayMs < LOW_RUNWAY_MS ? c.lavender : c.muted;
  const runway = hasWork ? runwayColor(`runway ${formatRunway(view.runwayMs)}`) : '';
  const left = [` ${goal}`, marks, runway].filter(Boolean).join('   ');
  return spread(left, c.muted(`shipped today ${view.shippedToday} `), width, visibleWidth);
}

function reviewDetail(review: Review): string {
  const parts: string[] = [];
  if (review.checks && review.checks.length > 0) {
    const passed = review.checks.filter(check => check.passed).length;
    const all = passed === review.checks.length;
    parts.push((all ? c.mint : c.rose)(`${all ? '✓' : '✗'} ${passed}/${review.checks.length} checks`));
  }
  parts.push(c.muted(`${review.files.length} file${review.files.length === 1 ? '' : 's'}`));
  return parts.join(c.muted(' · '));
}

/** What the Next line says, and the key that acts on it. */
function describe(item: NextItem, view: FadeView): { text: string; action: string } {
  switch (item.kind) {
    case 'stuck':
      return {
        text: `${c.lavender(GLYPH.review)} ${quoted(item.review.title)} ${c.lavender(`needs your answer: ${sanitize(item.review.question ?? '')}`)}`,
        action: 'answer',
      };
    case 'fresh':
      return { text: `${c.mint(GLYPH.ready)} ${c.muted('Ready')} ${quoted(item.title)}${c.muted('? The Companion just proposed it')}`, action: 'ready it' };
    case 'review': {
      const more = item.more > 0 ? c.muted(`  +${item.more} more`) : '';
      return { text: `${c.lavender(GLYPH.review)} ${quoted(item.review.title)} ${c.muted('landed ·')} ${reviewDetail(item.review)}${more}`, action: 'look' };
    }
    case 'idle':
      return item.draft
        ? { text: `${c.lavender('Builder is free')} ${c.muted('· ready')} ${quoted(item.draft)}${c.muted('?')}`, action: 'ready it' }
        : { text: `${c.lavender('Builder is free')} ${c.muted('· give it a task, or ask the Companion for the next step')}`, action: '' };
    case 'low':
      return item.draft
        ? { text: `${c.lavender(`runway ${formatRunway(item.runwayMs)}`)} ${c.muted('· ready')} ${quoted(item.draft)} ${c.muted('next?')}`, action: 'ready it' }
        : { text: `${c.lavender(`runway ${formatRunway(item.runwayMs)}`)} ${c.muted('· shape the next step with the Companion')}`, action: '' };
    case 'calm':
      return {
        text: view.building
          ? c.faint(`Nothing needs you. The Builder is on "${sanitize(view.building.title)}". Think ahead.`)
          : c.faint('Nothing needs you.'),
        action: '',
      };
  }
}

/**
 * The one thing worth your attention. `key` is how to act on it from where you are
 * ("⏎" on an empty line, otherwise "ctrl+r"). A card you just accepted dissolves here.
 */
export function nextLine(item: NextItem, view: FadeView, key: string, fading: Fading[], width: number, now: number): string {
  const dying = fading.at(-1);
  const label = item.kind === 'calm' ? c.faint('NEXT') : bold(c.lavender('NEXT'));
  if (dying && now - dying.start < FADE_MS) {
    return ` ${c.faint('NEXT')}  ${c.mint(GLYPH.done)} ${dissolve(dying.title, (now - dying.start) / FADE_MS)}`;
  }
  const { text, action } = describe(item, view);
  const hint = action ? `${c.text(key)} ${c.muted(action)} ` : '';
  return spread(` ${label}  ${text}`, hint, width, visibleWidth);
}

function thirdColumn(card: Card, view: FadeView): string {
  if (card.state === 'building') return '';
  if (card.state === 'review') {
    const review = view.reviews.find(r => r.title === card.title);
    if (review?.question) return c.lavender(`? ${sanitize(review.question)}`);
    if (review?.howToTry) return c.muted(sanitize(review.howToTry));
  }
  return c.faint(sanitize(card.body.split('\n')[0] ?? ''));
}

/** The expanded Plan: a header, one row per card, parked Later items, and the last few done entries. */
export function planLines(
  view: FadeView, selected: number, fading: Fading[], width: number, height: number, now: number,
): string[] {
  const header = spread(
    ` ${bold(c.mint('PLAN'))}${view.goal ? c.muted(`  ${sanitize(view.goal)}`) : ''}`,
    c.faint('↑↓ select  space ready  ⏎ open  n new  alt+↑↓ move  x drop '),
    width,
    visibleWidth,
  );
  const rows: { text: string; index: number }[] = [];
  view.cards.forEach((card, i) => {
    const mark = i === selected ? c.mint('›') : ' ';
    const title = sanitize(card.title);
    const name = i === selected ? bold(c.text(title.padEnd(24))) : c.text(title.padEnd(24));
    const state = stateColor(card)(card.state.padEnd(9));
    rows.push({ text: `${mark}${stateColor(card)(glyphFor(card))} ${name} ${state}${thirdColumn(card, view)}`, index: i });
  });
  for (const dying of fading) {
    const text = ` ${c.mint(GLYPH.done)} ${dissolve(dying.title.padEnd(24), (now - dying.start) / FADE_MS)}`;
    rows.splice(Math.min(dying.index, rows.length), 0, { text, index: -1 });
  }
  const extras: string[] = [];
  if (view.later.length > 0) extras.push(` ${c.faint(`↷ later: ${view.later.map(sanitize).join(' · ')}`)}`);
  extras.push(...view.done.slice(-3).map(entry => ` ${c.faint(`${GLYPH.done} ${sanitize(entry.title)}`)}`));
  const room = Math.max(0, height - 1 - extras.length);
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), rows.length - room));
  const visible = rows.slice(start, start + room).map(row => row.text);
  const lines = [header, ...visible, ...(room >= rows.length ? extras : [])];
  if (view.cards.length === 0) lines.splice(1, 0, ` ${c.muted('No steps yet. Press n for a new one, or ask the Companion.')}`);
  return lines.slice(0, height);
}

/** How many rows the open Plan list wants. */
export function planHeight(view: FadeView, rows: number, fading: number): number {
  const extras = (view.later.length > 0 ? 1 : 0) + Math.min(3, view.done.length);
  const wanted = 1 + Math.max(1, view.cards.length + fading) + extras;
  return Math.max(4, Math.min(Math.floor(rows * 0.4), wanted));
}
