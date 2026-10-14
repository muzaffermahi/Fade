import { Input, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';

import { commandHelp } from './commands.js';
import { terminalText, renderedText } from './terminal-text.js';
export const COMMAND_HELP = commandHelp('split');

/** Native focused overlay with bounded layout, text search and paging. */
export class InspectionView implements Component {
  private readonly search = new Input({ prompt: 'Search: ', placeholder: 'type to filter' });
  private page = 0;
  constructor(private readonly title: string, private readonly content: () => string,
    private readonly done: (action: 'close' | 'edit') => void, private readonly canEdit = false,
    private readonly interrupt: (data: string) => boolean = data => matchesKey(data, 'escape'),
    private readonly rows: () => number = () => 18) { this.search.focused = true; }
  handleInput(data: string): void {
    if (this.interrupt(data) || matchesKey(data, 'escape')) { this.done('close'); return; }
    if (this.canEdit && matchesKey(data, 'ctrl+e')) { this.done('edit'); return; }
    if (matchesKey(data, 'down') || matchesKey(data, 'pageDown')) this.page++;
    else if (matchesKey(data, 'up') || matchesKey(data, 'pageUp')) this.page = Math.max(0, this.page - 1);
    else { this.search.handleInput(data); this.page = 0; }
  }
  invalidate(): void { this.search.invalidate(); }
  render(width: number): string[] {
    const query = this.search.getValue().toLocaleLowerCase();
    const budget = Math.max(1, Math.floor(this.rows() * .9)), chrome = budget >= 4 ? 3 : budget >= 2 ? 2 : 1;
    const height = Math.max(1, Math.min(12, budget - chrome));
    const raw = this.content(), source = (terminalText(raw, 500000)
      + (raw.length > 500000 ? '\n[Inspection display truncated; narrow search or choose another retained page.]' : '')).split('\n');
    const lines = source.filter(line => !query || line.toLocaleLowerCase().includes(query)).flatMap(line => wrapTextWithAnsi(line, Math.max(1, width)));
    const maxPage = Math.max(0, Math.ceil(lines.length / height) - 1); this.page = Math.min(this.page, maxPage);
    const heading = width < 30 ? `Esc closes · ${this.page + 1}/${maxPage + 1}`
      : width < 45 ? `Esc closes · ${this.page + 1}/${maxPage + 1} · ${terminalText(this.title)}`
      : `${terminalText(this.title)} · ${this.page + 1}/${maxPage + 1} · Escape closes${this.canEdit ? ' · Ctrl+E edit' : ''}`;
    if (budget === 1) return [truncateToWidth(heading, width)];
    return [truncateToWidth(heading, width), ...this.search.render(width).map(renderedText),
      ...(budget >= 3 ? lines.slice(this.page * height, (this.page + 1) * height) : []),
      ...(budget >= 4 ? [truncateToWidth('↑↓ / PageUp / PageDown: page · type: search', width)] : [])];
  }
}
