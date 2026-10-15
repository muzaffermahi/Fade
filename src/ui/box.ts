import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { bold, c, paintLine } from './theme.js';

/** A rounded faint box with a mint title. `inner` lines are already styled. */
export function box(title: string, inner: string[], width: number): string[] {
  const edge = c.faint;
  const room = Math.max(4, width - 4);
  const label = ` ${bold(c.mint(title))} `;
  const top = `${edge('╭─')}${label}${edge('─'.repeat(Math.max(0, width - 3 - visibleWidth(label))) + '╮')}`;
  const rows = inner.map((line) => `${edge('│')} ${truncateToWidth(line, room, '…', true)} ${edge('│')}`);
  return [top, ...rows, edge(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)].map((line) => paintLine(line, width));
}
