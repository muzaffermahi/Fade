import { truncateToWidth, visibleWidth, type Editor } from '@earendil-works/pi-tui';
import type { FadeView } from '../loop.js';
import { builderPane } from './builder-pane.js';
import { CompanionRenderer } from './companion-pane.js';
import { compactMark } from './logo.js';
import { bold, c, paintLine, spinnerFrame, spread, underline } from './theme.js';
import { planLines, stripLines, type Fading } from './strip.js';

export type Focus = 'builder' | 'companion' | 'plan';
export const FOCUS_ORDER: Focus[] = ['builder', 'companion', 'plan'];

export const MIN_WIDTH = 60;
export const MIN_ROWS = 15; // render rows (terminal rows - 1) for a 60x16 terminal
export const WIDE_WIDTH = 100;

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
}

export interface ScreenParts {
  builderEditor: Editor;
  companionEditor: Editor;
  companion: CompanionRenderer;
}

const HINTS: Record<Focus, string> = {
  builder: 'tab focus · enter send · esc stop · ctrl+r review · ctrl+l log · ? help',
  companion: 'tab focus · enter send · esc stop reply · ctrl+r review · ? help',
  plan: 'tab focus · space ready · enter open · n new · x drop · ? help',
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

function stripHeight(view: FadeView, rows: number): number {
  const wanted = 1 + Math.max(1, view.cards.length) + Math.min(3, view.done.length);
  return Math.max(4, Math.min(Math.floor(rows * 0.4), wanted));
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
  const strip = planOpen ? planLines(view, st.selected, st.fading, width, stripHeight(view, rows), st.now)
    : stripLines(view, st.focus === 'plan', st.fading, width, st.now);
  const stripRows = planOpen ? stripHeight(view, rows) : 2;
  const top = wide ? [header(meta, width)] : [header(meta, width), tabs(view, st.focus, st.now)];
  // The panes' editors end in their own rule, so only the plan list needs a separate one.
  const closing = !wide && st.focus === 'plan' ? [rule] : [];
  const fixed = top.length + 1 + closing.length + stripRows + 1 + 1;
  const paneHeight = Math.max(3, rows - fixed);
  const body = wide ? widePanes(view, st, parts, width, paneHeight) : narrowPane(view, st, parts, width, paneHeight);
  const lines = [...top, rule, ...fit(body, width, paneHeight), ...closing, ...fit(strip, width, stripRows), rule, hintLine(view, st)];
  return fit(lines, width, rows).map(line => paintLine(line, width));
}

function widePanes(view: FadeView, st: ScreenState, parts: ScreenParts, width: number, height: number): string[] {
  const leftWidth = Math.floor((width - 1) / 2);
  const rightWidth = width - 1 - leftWidth;
  const left = fit(builderPane(view, {
    width: leftWidth, height, focused: st.focus === 'builder', scroll: st.scroll.builder, now: st.now, rawLog: st.rawLog,
  }, parts.builderEditor), leftWidth, height);
  const right = fit(parts.companion.render(view, {
    width: rightWidth, height, focused: st.focus === 'companion', scroll: st.scroll.companion, now: st.now,
  }, parts.companionEditor), rightWidth, height);
  return left.map((line, i) => `${line}${c.faint('│')}${right[i] ?? ''}`);
}

function narrowPane(view: FadeView, st: ScreenState, parts: ScreenParts, width: number, height: number): string[] {
  if (st.focus === 'plan') return planLines(view, st.selected, st.fading, width, height, st.now);
  if (st.focus === 'builder') {
    return builderPane(view, {
      width, height, focused: true, scroll: st.scroll.builder, now: st.now, rawLog: st.rawLog,
    }, parts.builderEditor);
  }
  return parts.companion.render(view, { width, height, focused: true, scroll: st.scroll.companion, now: st.now }, parts.companionEditor);
}
