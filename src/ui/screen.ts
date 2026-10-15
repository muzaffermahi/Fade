import { truncateToWidth, visibleWidth, type Editor } from '@earendil-works/pi-tui';
import type { NextItem } from '../flow.js';
import type { FadeView } from '../view.js';
import { builderPane } from './builder-pane.js';
import { CompanionRenderer } from './companion-pane.js';
import { compactMark, wordmark } from './logo.js';
import { bold, c, paintLine, spinnerFrame, spread, underline } from './theme.js';
import { nextLine, planHeight, planLines, threadLine, type Fading } from './strip.js';

export type Focus = 'builder' | 'companion' | 'plan';
export const FOCUS_ORDER: Focus[] = ['builder', 'companion', 'plan'];

export const MIN_WIDTH = 60;
export const MIN_ROWS = 15; // render rows (terminal rows - 1) for a 60x16 terminal
export const WIDE_WIDTH = 100;
const BANNER_MIN_ROWS = 26;

export interface UiMeta {
  cwd: string;
  branch: string;
  builderModel: string;
  companionModel: string;
}

export interface ScreenState {
  focus: Focus;
  scroll: { builder: number; companion: number };
  selected: number;
  rawLog: boolean;
  fading: Fading[];
  toast: string | undefined;
  now: number;
  /** The one thing shown on the Next line (already held back while you type). */
  next: NextItem;
  /** How to act on it from the current focus: "⏎" on an empty line, otherwise "ctrl+r". */
  nextKey: string;
}

export interface ScreenParts {
  builderEditor: Editor;
  companionEditor: Editor;
  companion: CompanionRenderer;
}

// Each fits in 80 columns.
const HINTS: Record<Focus, string> = {
  builder: 'tab focus · ⏎ send · esc stop · ctrl+r next · ctrl+n park · / commands · ? help',
  companion: 'tab focus · ⏎ send · esc stop · ctrl+r next · ctrl+n park · / commands · ? help',
  plan: 'tab focus · space ready · ⏎ open · n new · x drop · a r u t review · ? help',
};

function modelId(selector: string): string {
  return selector.includes('/') ? selector.slice(selector.indexOf('/') + 1) : selector;
}

function header(meta: UiMeta, width: number): string {
  const folder = meta.cwd.split(/[\\/]/).filter(Boolean).pop() ?? meta.cwd;
  const branch = meta.branch ? c.muted(` · ${meta.branch}`) : '';
  const left = ` ${compactMark()}   ${c.text(folder)}${branch}`;
  const right = c.muted(`builder · ${modelId(meta.builderModel)}   companion · ${modelId(meta.companionModel)} `);
  return spread(left, right, width, visibleWidth);
}

function isEmpty(view: FadeView): boolean {
  return view.companion.length === 0 && !view.companionLive;
}

/** The full wordmark across the top, until the first conversation starts. */
function banner(view: FadeView, width: number, rows: number): string[] {
  if (!isEmpty(view) || width < 76 || rows < BANNER_MIN_ROWS) return [];
  return ['', ...wordmark(width - 2).map(line => ` ${line}`), ''];
}

function tabs(view: FadeView, focus: Focus, now: number): string {
  const label = (name: string, which: Focus, extra = ''): string =>
    which === focus ? bold(underline(c.mint(`${name}${extra}`))) : c.faint(`${name}${extra}`);
  const building = view.building ? ` ${spinnerFrame(now)}` : '';
  return ` ${label('Builder', 'builder', building)}   ${label('Companion', 'companion')}   ${label('Plan', 'plan')}`;
}

function hintLine(view: FadeView, st: ScreenState): string {
  const toast = st.toast ?? view.toast;
  return toast ? ` ${c.mint(toast)}` : ` ${c.faint(HINTS[st.focus])}`;
}

function fit(lines: string[], width: number, height: number): string[] {
  const out = lines.slice(0, height).map(line => truncateToWidth(line, width, '…', true));
  while (out.length < height) out.push(' '.repeat(width));
  return out;
}

/** Exactly `height` rows, without touching widths (paintLine fits every line once, at the end). */
function rowsOf(lines: string[], height: number): string[] {
  const out = lines.slice(0, height);
  while (out.length < height) out.push('');
  return out;
}

export function renderScreen(
  view: FadeView, st: ScreenState, parts: ScreenParts, meta: UiMeta, width: number, rows: number,
): string[] {
  if (width < MIN_WIDTH || rows < MIN_ROWS) {
    const note = [c.text('Fade needs a slightly bigger window (60×16).')];
    return fit(note, width, rows).map(line => paintLine(line, width));
  }
  const wide = width >= WIDE_WIDTH;
  const rule = c.faint('─'.repeat(width));
  const planOpen = wide && st.focus === 'plan';
  const listRows = planOpen ? planHeight(view, rows, st.fading.length) : 0;
  const list = planOpen ? planLines(view, st.selected, st.fading, width, listRows, st.now) : [];
  const bottom = [threadLine(view, width), nextLine(st.next, view, st.nextKey, st.fading, width, st.now)];
  const topBanner = banner(view, width, rows);
  const heading = wide ? [header(meta, width)] : [header(meta, width), tabs(view, st.focus, st.now)];
  const top = [...topBanner, ...heading];
  // The panes' editors end in their own rule; the plan list (narrow) needs one of its own.
  const closing = (!wide && st.focus === 'plan') || planOpen ? [rule] : [];
  const fixed = top.length + 1 + list.length + closing.length + bottom.length + 1 + 1;
  const paneHeight = Math.max(3, rows - fixed);
  const showMark = topBanner.length === 0;
  const body = wide
    ? widePanes(view, st, parts, width, paneHeight, showMark)
    : narrowPane(view, st, parts, width, paneHeight, showMark);
  const lines = [
    ...top, rule, ...rowsOf(body, paneHeight), ...rowsOf(list, listRows), ...closing, ...bottom, rule, hintLine(view, st),
  ];
  return rowsOf(lines, rows).map(line => paintLine(line, width));
}

function widePanes(
  view: FadeView, st: ScreenState, parts: ScreenParts, width: number, height: number, showMark: boolean,
): string[] {
  const leftWidth = Math.floor((width - 1) / 2);
  const rightWidth = width - 1 - leftWidth;
  const left = fit(builderPane(view, {
    width: leftWidth, height, focused: st.focus === 'builder', scroll: st.scroll.builder, now: st.now, rawLog: st.rawLog,
  }, parts.builderEditor), leftWidth, height);
  const right = fit(parts.companion.render(view, {
    width: rightWidth, height, focused: st.focus === 'companion', scroll: st.scroll.companion, now: st.now, showMark,
  }, parts.companionEditor), rightWidth, height);
  return left.map((line, i) => `${line}${c.faint('│')}${right[i] ?? ''}`);
}

function narrowPane(
  view: FadeView, st: ScreenState, parts: ScreenParts, width: number, height: number, showMark: boolean,
): string[] {
  if (st.focus === 'plan') return planLines(view, st.selected, st.fading, width, height, st.now);
  if (st.focus === 'builder') {
    return builderPane(view, {
      width, height, focused: true, scroll: st.scroll.builder, now: st.now, rawLog: st.rawLog,
    }, parts.builderEditor);
  }
  return parts.companion.render(view, {
    width, height, focused: true, scroll: st.scroll.companion, now: st.now, showMark,
  }, parts.companionEditor);
}
