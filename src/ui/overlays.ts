import {
  Editor, matchesKey, SelectList, type Component, type Focusable, type TUI,
} from '@earendil-works/pi-tui';
import { checkMark, matchChecks, reviewLabel } from '../verdict.js';
import type { FileChange } from '../git.js';
import type { Review } from '../types.js';
import { box } from './box.js';
import { compactMark } from './logo.js';
import { recapLines, type RecapInput } from './recap.js';
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
  ['⏎ on empty line', 'do the NEXT thing: look at what landed, ready a step, answer'],
  ['ctrl+r', 'the same, from anywhere'],
  ['ctrl+n', 'park a thought in Later without leaving the thread'],
  ['tab / shift+tab', 'move focus: Builder → Companion → Plan'],
  ['⏎', 'send what you typed (Builder or Companion)'],
  ['esc', 'stop the Builder step / the Companion reply'],
  ['ctrl+l', 'raw Builder log'],
  ['pgup / pgdn', 'scroll the focused pane'],
  ['↑ ↓  (k j)', 'Plan: select a step'],
  ['space', 'Plan: ready a step / back to draft'],
  ['⏎', 'Plan: open a step (review or edit)'],
  ['n', 'Plan: new step'],
  ['alt+↑ ↓  (K J)', 'Plan: move the step'],
  ['x', 'Plan: drop the step'],
  ['a  r  u  t', 'review: accept · revise · undo · try it'],
  ['/', 'commands: /model, /goal, /later, /recap, /tree, /login… (type / for all)'],
  ['? or F1', 'this help'],
  ['ctrl+c', 'clear the input; twice to quit'],
];

export class HelpOverlay extends Overlay {
  constructor(rows: () => number, private readonly onClose: () => void) {
    super(rows);
  }

  render(width: number): string[] {
    const lines = [compactMark(), '', c.muted('One goal. One next thing. You navigate, the Builder drives.'), ''];
    for (const [key, what] of KEYS) lines.push(`${c.mint(key.padEnd(17))} ${c.text(what)}`);
    lines.push('', c.faint('Only you ready steps. Git is the undo button. esc closes.'));
    return box('Keys', lines.slice(0, this.maxInner()), width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || data === 'q' || data === '?') this.onClose();
  }
}

/** Read-only text in a box, e.g. /session. */
export class InfoOverlay extends Overlay {
  constructor(
    rows: () => number, private readonly title: string, private readonly text: string, private readonly onClose: () => void,
  ) {
    super(rows);
  }

  render(width: number): string[] {
    const lines = sanitize(this.text).split('\n').map(line => c.text(line));
    lines.push('', c.faint('esc closes'));
    return box(this.title, lines.slice(0, this.maxInner()), width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || data === 'q') this.onClose();
  }
}

// ---- review: feedback first, diff second ----

export interface ReviewActions {
  accept: () => void;
  revise: () => void;
  undo: () => void;
  /** Present only when the Builder left a command that shows the work. */
  tryIt?: () => void;
  close: () => void;
}

export class ReviewOverlay extends Overlay {
  private scroll = 0;
  private showDiff = false;
  private readonly diff: string[];

  constructor(
    rows: () => number, private readonly review: Review, private readonly changes: FileChange[],
    diffText: string, private readonly actions: ReviewActions,
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
      const detail = row.ran ? `Fade ran: exit ${row.ran.code} on ${row.ran.sha ?? 'uncommitted work'}`
        : row.look ? `your call: ${row.look}` : row.passed ? 'said, not run' : row.evidence ?? 'not addressed';
      lines.push(...wrap(`${mark} ${row.criterion}`, inner).map(line => paint(line)));
      lines.push(...wrap(detail, inner - 2).map(line => c.faint(`  ${line}`)));
      if (row.evidence && row.ran) lines.push(...wrap(`Builder said: ${row.evidence}`, inner).map(line => c.faint(line)));
      if (row.ran && row.ran.code !== 0) lines.push(...wrap(row.ran.tail, inner).map(line => c.rose(line)));
    }
    lines.push(c.faint('Proofs cover only what their commands check; looks are yours.'), '');
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
    const lines = [c.lavender(reviewLabel(r)), bold(c.text(sanitize(r.title))), ...wrap(r.summary, inner).map(l => c.text(l)), ''];
    if (r.question) {
      lines.push(...wrap(`Question: ${r.question}`, inner).map(l => c.lavender(l)), '');
    }
    lines.push(...this.checkLines(inner));
    if (r.howToTry) lines.push(...wrap(`Try it: ${r.howToTry}`, inner).map(l => c.mint(l)));
    if (r.tryCommand) lines.push(`${c.text('t')} ${c.muted(`runs: ${sanitize(r.tryCommand)}`)}`);
    if (r.howToTry || r.tryCommand) lines.push('');
    lines.push(...this.fileLines());
    if (!r.sha) lines.push(c.faint('No changes were committed for this step.'));
    else if (this.showDiff) lines.push('', ...this.diff);
    else lines.push(c.faint('d shows the full diff'));
    return lines;
  }

  private footer(): string {
    const keys = this.review.question
      ? ['r answer', 'u undo', 'a accept anyway']
      : this.review.verdict === 'look' ? ['a yes', 'r no, change…', 'u undo']
      : ['a accept', 'r revise', 'u undo', ...(this.actions.tryIt ? ['t try it'] : []), 'd diff'];
    return c.muted(`${keys.join(' · ')} · esc close`);
  }

  render(width: number): string[] {
    const body = this.body(width);
    const height = Math.max(3, this.maxInner() - 2);
    this.scroll = Math.min(this.scroll, Math.max(0, body.length - height));
    return box('Review', [...body.slice(this.scroll, this.scroll + height), '', this.footer()], width);
  }

  handleInput(data: string): void {
    const page = Math.max(3, this.maxInner() - 4);
    if (matchesKey(data, 'escape')) this.actions.close();
    else if (data === 'a') this.actions.accept();
    else if (data === 'r') this.actions.revise();
    else if (data === 'u') this.actions.undo();
    else if (data === 't' && this.actions.tryIt) this.actions.tryIt();
    else if (data === 'd' && this.review.sha) this.showDiff = !this.showDiff;
    else if (matchesKey(data, 'down') || data === 'j') this.scroll += 1;
    else if (matchesKey(data, 'up') || data === 'k') this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, 'pageDown')) this.scroll += page;
    else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - page);
  }
}

// ---- recap and goal closure ----

export class RecapOverlay extends Overlay {
  constructor(
    rows: () => number, private readonly input: RecapInput, private readonly footer: string,
    private readonly onEnter: () => void, private readonly onClose: () => void,
  ) {
    super(rows);
  }

  render(width: number): string[] {
    return recapLines({ ...this.input, footer: this.footer }, width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'enter')) this.onEnter();
    else if (matchesKey(data, 'escape') || data === 'q') this.onClose();
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

// ---- editors ----

export class CardEditorOverlay extends Overlay implements Focusable {
  private readonly editor: Editor;
  focused = true;

  constructor(
    tui: TUI, private readonly initial: { title: string; body: string },
    private readonly onSave: (title: string, body: string) => void, private readonly onCancel: () => void,
  ) {
    super(() => tui.terminal.rows);
    this.editor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.focused = true;
    this.editor.setText(initial.body ? `${initial.title}\n\n${initial.body}` : initial.title);
  }

  render(width: number): string[] {
    this.editor.focused = this.focused;
    const lines = this.editor.render(width - 4).slice(0, this.maxInner() - 2);
    const footer = c.muted('ctrl+s save · esc cancel · alt+enter newline');
    return box('Step', [c.faint('First line is the title; the rest is the body. End with "Done when: …".'), ...lines, footer], width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) return this.onCancel();
    if (matchesKey(data, 'ctrl+s')) {
      const [first = '', ...rest] = this.editor.getText().split('\n');
      const title = first.trim() || this.initial.title;
      return this.onSave(title, rest.join('\n').trim());
    }
    this.editor.handleInput(data);
  }
}

export class TextPromptOverlay extends Overlay implements Focusable {
  private readonly editor: Editor;
  focused = true;

  constructor(
    tui: TUI, private readonly question: string,
    private readonly onSubmit: (text: string) => void, private readonly onCancel: () => void,
  ) {
    super(() => tui.terminal.rows);
    this.editor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.editor.focused = true;
    this.editor.onSubmit = text => {
      if (text.trim()) this.onSubmit(text.trim());
    };
  }

  render(width: number): string[] {
    this.editor.focused = this.focused;
    return box(this.question, [...this.editor.render(width - 4), c.muted('⏎ ok · esc cancel')], width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape')) this.onCancel();
    else this.editor.handleInput(data);
  }
}

export class ConfirmOverlay extends Overlay {
  constructor(rows: () => number, private readonly question: string, private readonly onYes: () => void, private readonly onNo: () => void) {
    super(rows);
  }

  render(width: number): string[] {
    return box('Sure?', [c.text(this.question), '', `${c.mint('y')} ${c.muted('yes')}   ${c.mint('n')} ${c.muted('no')}`], width);
  }

  handleInput(data: string): void {
    if (data === 'y' || data === 'Y') this.onYes();
    else if (data === 'n' || data === 'N' || matchesKey(data, 'escape')) this.onNo();
  }
}
