import { visibleWidth } from '@earendil-works/pi-tui';
import type { FadeView } from '../view.js';
import { reviewLabel } from '../verdict.js';
import { c, clock, sanitize, wrap } from './theme.js';

/** True while something is building or waiting on the human. */
export function hasWork(view: FadeView): boolean {
  return view.building !== null || view.reviews.length > 0;
}

/** One line for narrow screens: what the Builder is doing, so talking alongside it is never a mystery. */
export function statusLine(view: FadeView, now: number): string {
  const bits: string[] = [];
  if (view.building) bits.push(`builder ◌ ${view.building.title} ${clock(now - view.building.startedAt)}`);
  else bits.push('builder idle');
  const next = view.cards.filter((card) => card.state === 'ready').length;
  if (next) bits.push(`${next} up next`);
  if (view.reviews.length) bits.push(`${view.reviews.length} needs you`);
  const hint = view.building ? 'keep talking while it builds' : 'tell fade what to build';
  return c.muted(` ${sanitize(bits.join(' · '))}`) + c.faint(` · ${hint}`);
}

/** Wrap before coloring; even an unbroken path fits and retains its hanging indent. */
function hanging(text: string, prefix: string, width: number): string[] {
  const room = Math.max(1, width - visibleWidth(prefix) - 1);
  const lines: string[] = [];
  for (const line of wrap(sanitize(text), room)) {
    let chunk = '';
    for (const char of line) {
      if (chunk && visibleWidth(chunk + char) > room) {
        lines.push(chunk);
        chunk = '';
      }
      chunk += char;
    }
    lines.push(chunk);
  }
  return lines.map((line, i) => c.text(`${i === 0 ? prefix : ' '.repeat(visibleWidth(prefix))}${line}`));
}

/** Faint guidance shown in an empty section, so the sidebar explains itself. */
function note(text: string, width: number): string[] {
  return wrap(text, Math.max(1, width - 4)).map((line) => c.faint(`   ${line}`));
}

function builderSection(view: FadeView, width: number, now: number): string[] {
  const building = view.building;
  if (!building) return [c.muted(' BUILDER'), ...note('Idle. Tell Fade what to build and it starts here.', width)];
  const title = `${building.title} ${clock(now - building.startedAt)}`;
  const lines = [c.muted(' BUILDER'), ...hanging(title, ' ◌ ', width)];
  for (const step of building.steps) {
    const mark = { done: '✓', active: '◌', todo: '○' }[step.status];
    lines.push(...hanging(step.text, `   ${mark} `, width));
  }
  if (building.action) lines.push(...hanging(building.action, '     └ ', width));
  return lines;
}

function nextSection(view: FadeView, width: number): string[] {
  const lines = [c.muted(' UP NEXT')];
  for (const card of view.cards) {
    if (card.state === 'ready') lines.push(...hanging(card.title, ' ○ ', width));
    if (card.state === 'draft') lines.push(...hanging(`${card.title} (say yes)`, ' · ', width));
  }
  if (lines.length > 1) return lines;
  const empty = view.building
    ? 'Keep talking while it builds. Plan the next thing; it lines up here.'
    : 'Anything you plan ahead lines up here.';
  return [...lines, ...note(empty, width)];
}

function needsYouSection(view: FadeView, width: number): string[] {
  const lines = [c.muted(' NEEDS YOU')];
  for (const review of view.reviews) {
    const question = review.question ?? review.checks?.find((check) => check.look && !check.ran)?.look;
    const mark = review.verdict === 'said' || review.verdict === 'none' ? '○' : '◆';
    lines.push(...hanging(`${review.title} — ${question ?? reviewLabel(review)}`, ` ${mark} `, width));
  }
  if (lines.length > 1) return lines;
  return [...lines, ...note('Nothing. Checked work lands on its own; only taste questions wait here.', width)];
}

/** The always-open sidebar: the Builder, what's lined up after it, and what waits on you. */
export function rail(view: FadeView, width: number, now: number, height: number): string[] {
  const sections = [builderSection(view, width, now), nextSection(view, width), needsYouSection(view, width)];
  const rooms = shareRows(
    sections.map((lines) => lines.length),
    height - sections.length + 1,
  );
  return sections.flatMap((lines, i) => {
    const room = rooms[i] ?? 2;
    return [
      ...(i ? [''] : []),
      ...lines.slice(0, room - (lines.length > room ? 1 : 0)),
      ...(lines.length > room ? [c.faint('   …')] : []),
    ];
  });
}

/** Short sections keep all their rows; whatever is left is split among the long ones. */
function shareRows(wants: number[], total: number): number[] {
  const rooms = wants.map(() => 0);
  let open = wants.map((_, i) => i);
  let left = total;
  while (open.length > 0) {
    const share = Math.max(2, Math.floor(left / open.length));
    const small = open.filter((i) => (wants[i] ?? 0) <= share);
    if (small.length === 0) {
      for (const i of open) rooms[i] = share;
      break;
    }
    for (const i of small) {
      rooms[i] = wants[i] ?? 0;
      left -= rooms[i] ?? 0;
    }
    open = open.filter((i) => !small.includes(i));
  }
  return rooms;
}
