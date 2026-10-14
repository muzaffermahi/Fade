import { visibleWidth } from '@earendil-works/pi-tui';
import type { FadeView } from '../loop.js';
import type { Card } from '../types.js';
import { bold, c, GLYPH, sanitize, spread } from './theme.js';

export interface Fading {
  title: string;
  start: number;
  /** Where the card sat in the plan, so it dissolves in place. */
  index: number;
}

export const FADE_MS = 700;

const DUST = ['▓', '▒', '░', '·', ' '];

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

function reviewSlot(view: FadeView, fading: Fading[], now: number): string {
  const first = view.reviews[0];
  if (!first) {
    const dying = fading[0];
    if (dying) return `${c.mint(GLYPH.done)} ${dissolve(dying.title, (now - dying.start) / FADE_MS)}`;
    return c.faint('nothing to review');
  }
  const detail = first.question ? 'needs your answer' : `${first.files.length} file${first.files.length === 1 ? '' : 's'}`;
  const more = view.reviews.length > 1 ? c.muted(`  +${view.reviews.length - 1} more`) : '';
  const dying = fading.find(f => f.title === first.title);
  const title = dying ? dissolve(dying.title, (now - dying.start) / FADE_MS) : c.text(sanitize(first.title));
  return `${c.lavender(GLYPH.review)} ${title} ${c.muted(`· ${detail}`)}${more}`;
}

function upNext(view: FadeView): string {
  const items = view.cards.filter(card => card.state === 'ready' || card.state === 'draft');
  if (view.building === null && !items.some(card => card.state === 'ready')) {
    return c.lavender('Builder is free: mark a card ready (space) or tell it what to do');
  }
  if (items.length === 0) return c.faint('nothing queued');
  return items.map(card => `${stateColor(card)(glyphFor(card))} ${card.state === 'ready' ? c.text(sanitize(card.title)) : c.faint(sanitize(card.title))}`).join('   ');
}

/** The two always-visible lines: what needs review, and what is up next. */
export function stripLines(view: FadeView, planFocused: boolean, fading: Fading[], width: number, now: number): string[] {
  const hint = planFocused
    ? c.text('⏎ look   a accept   r revise   u undo')
    : c.faint('⏎ look   a accept   r revise   u undo');
  const labelColor = view.reviews.length > 0 ? (s: string) => bold(c.lavender(s)) : c.faint;
  const first = spread(` ${labelColor('TO REVIEW')}  ${reviewSlot(view, fading, now)}`, `${hint} `, width, visibleWidth);
  const shipped = c.muted(`shipped today ${view.shippedToday}`);
  const second = spread(` ${c.faint('UP NEXT')}    ${upNext(view)}`, `${shipped} `, width, visibleWidth);
  return [first, second];
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

/** The expanded Plan: a header, one row per card, and the last few done entries. */
export function planLines(
  view: FadeView, selected: number, fading: Fading[], width: number, height: number, now: number,
): string[] {
  const header = spread(
    ` ${bold(c.mint('PLAN'))}`,
    c.faint('↑↓ select  space ready  ⏎ open  n new  alt+↑↓ move  x drop '),
    width,
    visibleWidth,
  );
  const rows: { text: string; index: number }[] = [];
  const cards = [...view.cards];
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
  const done = view.done.slice(-3).map(entry => ({ text: ` ${c.faint(`${GLYPH.done} ${sanitize(entry.title)}`)}`, index: -2 }));
  const room = Math.max(0, height - 1 - done.length);
  const start = Math.max(0, Math.min(selected - Math.floor(room / 2), rows.length - room));
  const visible = rows.slice(start, start + room).map(row => row.text);
  const lines = [header, ...visible, ...(room >= rows.length ? done : []).map(row => row.text)];
  if (cards.length === 0) lines.splice(1, 0, ` ${c.muted('No cards yet. Press n for a new one, or ask the Companion.')}`);
  return lines.slice(0, height);
}
