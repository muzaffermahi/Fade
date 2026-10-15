import {
  matchesKey, SelectList, type Component,
} from '@earendil-works/pi-tui';
import { checkMark, matchChecks } from '../verdict.js';
import type { FileChange } from '../git.js';
import type { Review } from '../types.js';
import { box } from './box.js';
import { compactMark } from './logo.js';
import { bold, c, keepColorsOnly, sanitize, wrap } from './theme.js';

export { box } from './box.js';

export function editorTheme() {
  const id = (s: string): string => s;
  return {
    borderColor: c.faint,
    selectList: { selectedPrefix: c.mint, selectedText: id, description: c.muted, scrollInfo: c.faint, noMatch: c.muted },
  };
}

abstract class Overlay implements Component {
  constructor(protected readonly rows: () => number) {}
  invalidate(): void {}
  abstract render(width: number): string[];
  abstract handleInput(data: string): void;
  protected maxInner(): number {
    return Math.max(4, Math.floor(this.rows() * 0.8) - 2);
  }
}

// ---- help ----

const KEYS: [string, string][] = [
  ['⏎', 'send'], ['esc', 'stop the reply / close a view'],
  ['pgup / pgdn', 'scroll'], ['ctrl+c twice', 'quit (first press clears input)'],
];

export class HelpOverlay extends Overlay {
  constructor(rows: () => number, private readonly onClose: () => void) {
    super(rows);
  }

  render(width: number): string[] {
    const lines = [compactMark(), '', c.muted('Just talk to Fade. The work runs beside you.'), ''];
    for (const [key, what] of KEYS) lines.push(`${c.mint(key.padEnd(17))} ${c.text(what)}`);
    lines.push('', ...wrap('Say "yes", "undo that", "stop", "show me the diff", or tell me what to change.', width - 4).map(c.text));
    lines.push('', ...wrap('/model · /login · /new · /show · /help · /quit', width - 4).map(c.muted));
    return box('Keys', lines.slice(0, this.maxInner()), width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || data === 'q' || data === '?') this.onClose();
  }
}

// ---- review: feedback first, diff second ----

export class ShowOverlay extends Overlay {
  private scroll = 0;
  private readonly diff: string[];

  constructor(
    rows: () => number, private readonly review: Review, private readonly changes: FileChange[],
    diffText: string, private readonly onClose: () => void,
  ) {
    super(rows);
    this.diff = keepColorsOnly(diffText).split('\n');
  }

  /** "Done when" lines with the Builder's own verdict, or marked unchecked. */
  private checkLines(inner: number): string[] {
    const criteria = this.review.doneWhen ?? [];
    if (criteria.length === 0) return [c.faint('no checks agreed'), ''];
    const lines = [c.muted('Done when')];
    for (const row of matchChecks(criteria, this.review.checks ?? [])) {
      const mark = checkMark(row);
      const paint = mark === '✓' ? c.mint : mark === '✗' ? c.rose : row.look ? c.lavender : c.faint;
      const detail = row.ran ? `Fade ran ${row.proof ?? 'the check'}: exit ${row.ran.code} on ${row.ran.sha ?? 'uncommitted work'}`
        : row.look ? `your call: ${row.look}` : row.passed ? 'I could not run a check for this'  : row.evidence ?? 'not addressed';
      lines.push(...wrap(`${mark} ${row.criterion}`, inner).map(line => paint(line)));
      lines.push(...wrap(detail, inner - 2).map(line => c.faint(`  ${line}`)));
      if (row.evidence && row.ran) lines.push(...wrap(`Builder said: ${row.evidence}`, inner).map(line => c.faint(line)));
      if (row.ran) lines.push(...wrap(row.ran.tail, inner).map(line => (row.ran?.code === 0 ? c.muted : c.rose)(line)));
    }
    lines.push('');
    return lines;
  }

  private fileLines(): string[] {
    if (this.changes.length === 0) {
      return this.review.files.length > 0 ? [`${c.muted('Changed')}  ${c.text(this.review.files.join(' · '))}`] : [];
    }
    const items = this.changes.map(ch => `${c.text(ch.file)} ${c.mint(`+${ch.added}`)} ${c.rose(`−${ch.removed}`)}`);
    return [`${c.muted('Changed')}  ${items.join(c.faint(' · '))}`];
  }

  private body(width: number): string[] {
    const inner = width - 4;
    const r = this.review;
    const lines = [c.lavender('Built result'), bold(c.text(sanitize(r.title))), ...wrap(r.summary, inner).map(l => c.text(l)), ''];
    if (r.question) {
      lines.push(...wrap(`Question: ${r.question}`, inner).map(l => c.lavender(l)), '');
    }
    lines.push(...this.checkLines(inner));
    if (r.howToTry) lines.push(...wrap(`Try it: ${r.howToTry}`, inner).map(l => c.mint(l)));
    if (r.tryCommand) lines.push(c.muted(`Try: ${sanitize(r.tryCommand)}`));
    if (r.howToTry || r.tryCommand) lines.push('');
    lines.push(...this.fileLines());
    if (!r.sha) lines.push(c.faint('No changes were committed for this step.'));
    else lines.push('', ...this.diff);
    return lines;
  }

  render(width: number): string[] {
    const body = this.body(width);
    const height = Math.max(3, this.maxInner() - 2);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - height));
    return box('Show', [...body.slice(this.scroll, this.scroll + height), '', c.muted('pgup / pgdn scroll · esc close')], width);
  }

  handleInput(data: string): void {
    const page = Math.max(3, this.maxInner() - 4);
    if (matchesKey(data, 'escape')) this.onClose();
    else if (matchesKey(data, 'pageDown')) this.scroll += page;
    else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - page);
  }
}

// ---- model picker ----

export class ModelPickerOverlay extends Overlay {
  private readonly list: SelectList;
  private filter = '';

  constructor(
    rows: () => number, private readonly role: string, models: string[], current: string,
    onPick: (selector: string) => void, private readonly onClose: () => void,
  ) {
    super(rows);
    this.list = new SelectList(models.map(m => ({ value: m, label: m === current ? `${m}  (current)` : m })), 10, editorTheme().selectList);
    const index = models.indexOf(current);
    if (index >= 0) this.list.setSelectedIndex(index);
    this.list.onSelect = item => onPick(item.value);
    this.list.onCancel = () => onClose();
  }

  render(width: number): string[] {
    const filter = this.filter ? c.text(this.filter) : c.faint('type to filter');
    const lines = [`${c.muted('Filter')} ${filter}`, '', ...this.list.render(width - 4), '', c.muted('⏎ choose · esc cancel')];
    return box(`${this.role} model`, lines.slice(0, this.maxInner()), width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) return this.onClose();
    if (matchesKey(data, 'backspace')) {
      this.filter = this.filter.slice(0, -1);
      this.list.setFilter(this.filter);
      return;
    }
    if (data.length === 1 && data >= ' ' && data !== '\x7f') {
      this.filter += data;
      this.list.setFilter(this.filter);
      return;
    }
    this.list.handleInput(data);
  }
}
