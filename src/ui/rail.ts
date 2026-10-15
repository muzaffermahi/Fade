import { visibleWidth } from '@earendil-works/pi-tui';
import type { FadeView } from '../view.js';
import { reviewLabel } from '../verdict.js';
import { c, clock, sanitize, wrap } from './theme.js';

export function hasRail(view: FadeView): boolean {
  return view.building !== null || view.reviews.length > 0;
}

export function statusLine(view: FadeView, now: number): string {
  const bits: string[] = [];
  if (view.building) bits.push(`◌ ${view.building.title} ${clock(now - view.building.startedAt)}`);
  const next = view.cards.filter((card) => card.state === 'ready').length;
  if (next) bits.push(`${next} queued`);
  if (view.reviews.length) bits.push(`${view.reviews.length} needs you`);
  return c.muted(` ${sanitize(bits.join(' · '))}`);
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

export function rail(view: FadeView, width: number, now: number, height: number): string[] {
  const sections: string[][] = [];
  const building = view.building;
  if (building) {
    const lines = [c.muted(' NOW'), ...hanging(`${building.title} ${clock(now - building.startedAt)}`, ' ◌ ', width)];
    for (const step of building.steps) {
      const mark = { done: '✓', active: '◌', todo: '○' }[step.status];
      lines.push(...hanging(step.text, `   ${mark} `, width));
    }
    if (building.action) lines.push(...hanging(building.action, '     └ ', width));
    sections.push(lines);
  }
  const queued = view.cards.filter((card) => card.state === 'ready');
  if (queued.length) sections.push([c.muted(' NEXT'), ...queued.flatMap((card) => hanging(card.title, ' ○ ', width))]);
  if (view.reviews.length) {
    const lines = [c.muted(' NEEDS YOU')];
    for (const review of view.reviews) {
      const question = review.question ?? review.checks?.find((check) => check.look && !check.ran)?.look;
      const mark = review.verdict === 'said' || review.verdict === 'none' ? '○' : '◆';
      lines.push(...hanging(`${review.title} — ${question ?? reviewLabel(review)}`, ` ${mark} `, width));
    }
    sections.push(lines);
  }
  const room = Math.max(2, Math.floor((height - sections.length + 1) / Math.max(1, sections.length)));
  return sections.flatMap((lines, i) => [
    ...(i ? [''] : []),
    ...lines.slice(0, room - (lines.length > room ? 1 : 0)),
    ...(lines.length > room ? [c.faint('   …')] : []),
  ]);
}
