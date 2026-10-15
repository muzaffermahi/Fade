// Breakpoint-timed attention. Interruptions cost far less at natural task boundaries, so the Next line never
// changes under you while you're mid-thought: new things wait until you send, clear the line, or pause.
import { itemKey, wantsSignal, type NextItem } from '../flow.js';
import type { FadeView } from '../view.js';
import { sanitize } from './theme.js';

/** How long after your last keystroke Fade keeps holding new things back. */
export const QUIET_MS = 4000;

/** Is a previously shown item still true? (Resolved items may disappear even while you type.) */
function stillValid(item: NextItem, view: FadeView): boolean {
  const hasReady = view.cards.some(card => card.state === 'ready');
  switch (item.kind) {
    case 'stuck': return view.reviews.some(r => r.title === item.review.title && r.question);
    case 'review': return view.reviews.some(r => r.title === item.review.title);
    case 'fresh': return view.freshDraft === item.title;
    case 'idle': return view.building === null && !hasReady;
    case 'low': return view.building !== null && !hasReady;
    case 'calm': return true;
  }
}

export class Attention {
  private shown: NextItem = { kind: 'calm' };
  private shownKey = 'calm';
  private lastKeyAt = 0;
  private first = true;

  constructor(private readonly onSignal: (item: NextItem) => void) {}

  keystroke(now = Date.now()): void {
    this.lastKeyAt = now;
  }

  quiet(editorHasText: boolean, now = Date.now()): boolean {
    return editorHasText || now - this.lastKeyAt < QUIET_MS;
  }

  /** Picks what the Next line shows: the newest candidate at a breakpoint, otherwise whatever was already there. */
  resolve(candidate: NextItem, view: FadeView, quiet: boolean): NextItem {
    let next: NextItem;
    if (!quiet) next = candidate;
    else if (stillValid(this.shown, view)) next = this.shown;
    else next = { kind: 'calm' };
    const key = itemKey(next);
    if (key !== this.shownKey) {
      if (!this.first && wantsSignal(next)) this.onSignal(next);
      this.shownKey = key;
    }
    this.first = false;
    this.shown = next;
    return next;
  }
}

/** The terminal title: readable from another window, so you know when to come back. */
export function windowTitle(view: FadeView, next: NextItem, folder: string): string {
  switch (next.kind) {
    case 'stuck': return `Fade · ? the Builder needs you`;
    case 'review': return `Fade · ◆ ${sanitize(next.review.title)} landed`;
    case 'idle': return 'Fade · builder idle';
    default:
      return view.building ? `Fade · building ${sanitize(view.building.title)}` : `Fade · ${sanitize(view.goal || folder)}`;
  }
}
