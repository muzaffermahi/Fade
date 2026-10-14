import {
  Editor, matchesKey, truncateToWidth, visibleWidth, type Component, type Focusable, type TUI,
} from '@earendil-works/pi-tui';
import { compactMark } from './logo.js';
import { bold, c, keepColorsOnly, paintLine, sanitize, wrap } from './theme.js';
import type { Review } from '../types.js';

/** A rounded faint box with a mint title. `inner` lines are already styled. */
export function box(title: string, inner: string[], width: number): string[] {
  const edge = c.faint;
  const room = Math.max(4, width - 4);
  const label = ` ${bold(c.mint(title))} `;
  const top = `${edge('╭─')}${label}${edge('─'.repeat(Math.max(0, width - 3 - visibleWidth(label)) ) + '╮')}`;
  const rows = inner.map(line => `${edge('│')} ${truncateToWidth(line, room, '…', true)} ${edge('│')}`);
  return [top, ...rows, edge(`╰${'─'.repeat(Math.max(0, width - 2))}╯`)].map(line => paintLine(line, width));
}

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
  ['tab / shift+tab', 'move focus: Builder → Companion → Plan'],
  ['enter', 'send what you typed (Builder or Companion)'],
  ['esc', 'stop the Builder card / the Companion reply'],
  ['ctrl+r', 'open the first card waiting for review'],
  ['ctrl+l', 'raw Builder log'],
  ['pgup / pgdn', 'scroll the focused pane'],
  ['↑ ↓  (k j)', 'Plan: select a card'],
  ['space', 'Plan: mark a card ready / back to draft'],
  ['enter', 'Plan: open a card (review or edit)'],
  ['n', 'Plan: new card'],
  ['alt+↑ ↓  (K J)', 'Plan: move the card'],
  ['x', 'Plan: drop the card'],
  ['a  r  u', 'review: accept · revise · undo'],
  ['? or F1', 'this help'],
  ['ctrl+c', 'clear the input; twice to quit'],
];

export class HelpOverlay extends Overlay {
  constructor(rows: () => number, private readonly onClose: () => void) {
    super(rows);
  }

  render(width: number): string[] {
    const lines = [compactMark(), ''];
    for (const [key, what] of KEYS) lines.push(`${c.mint(key.padEnd(16))} ${c.text(what)}`);
    lines.push('', c.faint('Only you mark cards ready. Git is the undo button. esc closes.'));
    return box('Keys', lines.slice(0, this.maxInner()), width);
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'escape') || matchesKey(data, 'enter') || data === 'q' || data === '?') this.onClose();
  }
}

// ---- review ----

export interface ReviewActions {
  accept: () => void;
  revise: () => void;
  undo: () => void;
  close: () => void;
}

export class ReviewOverlay extends Overlay {
  private scroll = 0;
  private readonly diff: string[];

  constructor(rows: () => number, private readonly review: Review, diffText: string, private readonly actions: ReviewActions) {
    super(rows);
    this.diff = keepColorsOnly(diffText).split('\n');
  }

  private head(width: number): string[] {
    const inner = width - 4;
    const lines = [bold(c.text(sanitize(this.review.title))), ...wrap(this.review.summary, inner).map(l => c.text(l))];
    if (this.review.question) {
      lines.push('', ...wrap(`Question: ${this.review.question}`, inner).map(l => c.lavender(l)));
    } else if (this.review.howToTry) {
      lines.push('', ...wrap(`Try it: ${this.review.howToTry}`, inner).map(l => c.mint(l)));
    }
    return lines;
  }

  private diffHeight(headLines: number): number {
    return Math.max(2, this.maxInner() - headLines - 3);
  }

  render(width: number): string[] {
    const head = this.head(width);
    const height = this.diffHeight(head.length);
    this.scroll = Math.min(this.scroll, Math.max(0, this.diff.length - height));
    const slice = this.diff.slice(this.scroll, this.scroll + height);
    const body = this.review.sha ? slice : [c.faint('No changes were committed for this card.')];
    const footer = c.muted('a accept · r revise · u undo · ↑↓ scroll · esc close');
    return box('Review', [...head, '', ...body, '', footer], width);
  }

  handleInput(data: string): void {
    const page = this.diffHeight(this.head(60).length);
    if (matchesKey(data, 'escape')) this.actions.close();
    else if (data === 'a') this.actions.accept();
    else if (data === 'r') this.actions.revise();
    else if (data === 'u') this.actions.undo();
    else if (matchesKey(data, 'down') || data === 'j') this.scroll += 1;
    else if (matchesKey(data, 'up') || data === 'k') this.scroll = Math.max(0, this.scroll - 1);
    else if (matchesKey(data, 'pageDown')) this.scroll += page;
    else if (matchesKey(data, 'pageUp')) this.scroll = Math.max(0, this.scroll - page);
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
    return box('Card', [c.faint('First line is the title; the rest is the body.'), ...lines, footer], width);
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
    return box(this.question, [...this.editor.render(width - 4), c.muted('enter ok · esc cancel')], width);
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
