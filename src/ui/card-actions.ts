// The dialogs around one step: look at what landed, revise it, undo it, drop it, write or edit it.
import { matchesKey, type Component, type TUI } from '@earendil-works/pi-tui';
import type { Git } from '../git.js';
import type { Fade } from '../loop.js';
import { CardEditorOverlay, ConfirmOverlay, ReviewOverlay, TextPromptOverlay } from './overlays.js';

export interface CardHost {
  readonly fade: Fade;
  readonly tui: TUI;
  readonly rows: () => number;
  show(component: Component): void;
  close(): void;
  toast(text: string): void;
  /** Accept with the dissolve animation. */
  accept(title: string): void;
  tryIt(title: string): void;
}

export class CardActions {
  constructor(private readonly host: CardHost, private readonly git: Git) {}

  /** Opens a step: the review screen if it landed, otherwise the editor. */
  open(title: string): void {
    const { fade, tui } = this.host;
    const card = fade.view().cards.find(c => c.title === title);
    if (!card) return;
    if (card.state === 'review') return this.review(title);
    if (card.state === 'building') return this.host.toast('The Builder is on this one');
    this.host.show(new CardEditorOverlay(tui, card, (newTitle, body) => {
      fade.editCard(title, { title: newTitle, body });
      this.host.close();
    }, () => this.host.close()));
  }

  review(title: string): void {
    const host = this.host;
    const review = host.fade.view().reviews.find(r => r.title === title)
      ?? { verdict: 'none' as const, title, summary: 'Ready for a look.', howToTry: '', files: [], finishedAt: Date.now() };
    const diff = review.sha ? this.git.show(review.sha) : '';
    const changes = review.sha ? this.git.numstat(review.sha) : [];
    const then = (action: () => void) => () => {
      host.close();
      action();
    };
    host.show(new ReviewOverlay(host.rows, review, changes, diff, {
      accept: then(() => host.accept(title)),
      revise: then(() => this.revise(title)),
      undo: then(() => this.undo(title)),
      ...(review.tryCommand ? { tryIt: () => host.tryIt(title) } : {}),
      close: () => host.close(),
    }));
  }

  revise(title: string): void {
    const { fade, tui } = this.host;
    const stuck = fade.view().reviews.find(r => r.title === title)?.question;
    this.host.show(new TextPromptOverlay(tui, stuck ? 'Your answer' : 'What should change?', note => {
      this.host.close();
      fade.revise(title, note);
    }, () => this.host.close()));
  }

  undo(title: string): void {
    this.host.show(new ConfirmOverlay(this.host.rows, `Undo "${title}"? Fade will queue a step to revert it.`, () => {
      this.host.close();
      this.host.fade.undo(title);
    }, () => this.host.close()));
  }

  drop(title: string): void {
    this.host.show(new ConfirmOverlay(this.host.rows, `Drop "${title}"?`, () => {
      this.host.close();
      this.host.fade.drop(title);
    }, () => this.host.close()));
  }

  create(): void {
    const { fade, tui } = this.host;
    this.host.show(new TextPromptOverlay(tui, 'New step title', title => {
      this.host.close();
      this.host.show(new CardEditorOverlay(tui, { title, body: '' }, (finalTitle, body) => {
        fade.addCard(finalTitle, body);
        this.host.close();
      }, () => this.host.close()));
    }, () => this.host.close()));
  }
}

export interface PlanKeyHost extends CardHost {
  readonly cards: CardActions;
  /** The selected row in the Plan list. */
  selected: number;
  openHelp(): void;
  requestRender(): void;
}

/** Keys while the Plan has focus: select, ready, open, move, drop, and act on steps that landed. */
export function handlePlanKey(host: PlanKeyHost, data: string): void {
  const fade = host.fade;
  const cards = fade.view().cards;
  host.selected = Math.max(0, Math.min(cards.length - 1, host.selected));
  const card = cards[host.selected];
  const move = (direction: -1 | 1): void => {
    if (!card) return;
    fade.move(card.title, direction);
    host.selected = Math.max(0, Math.min(cards.length - 1, host.selected + direction));
  };
  if (matchesKey(data, 'alt+up') || data === 'K') move(-1);
  else if (matchesKey(data, 'alt+down') || data === 'J') move(1);
  else if (matchesKey(data, 'up') || data === 'k') host.selected = Math.max(0, host.selected - 1);
  else if (matchesKey(data, 'down') || data === 'j') host.selected = Math.min(cards.length - 1, host.selected + 1);
  else if (data === 'n') return host.cards.create();
  else if (data === '?') return host.openHelp();
  else if (data === 'u' && fade.view().lastQuiet) {
    const title = fade.view().lastQuiet?.title;
    if (title) fade.undoDone(title);
  }
  else if (!card) return;
  else if (matchesKey(data, 'space')) fade.toggleReady(card.title);
  else if (matchesKey(data, 'enter')) host.cards.open(card.title);
  else if (data === 'x') host.cards.drop(card.title);
  else if (card.state === 'review' && data === 'a') host.accept(card.title);
  else if (card.state === 'review' && data === 'r') host.cards.revise(card.title);
  else if (card.state === 'review' && data === 'u') host.cards.undo(card.title);
  else if (card.state === 'review' && data === 't') host.tryIt(card.title);
  host.requestRender();
}
