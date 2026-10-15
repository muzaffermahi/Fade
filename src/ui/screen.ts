import { truncateToWidth, visibleWidth, type Editor } from '@earendil-works/pi-tui';
import type { FadeView } from '../view.js';
import { CompanionRenderer } from './companion-pane.js';
import { editorBlock } from './pane.js';
import { hasRail, rail, statusLine } from './rail.js';
import { c, paintLine, sanitize, spread } from './theme.js';

export const MIN_WIDTH = 60;
export const MIN_ROWS = 15;
export const WIDE_WIDTH = 100;
export interface UiMeta {
  cwd: string;
  branch: string;
  builderModel: string;
  companionModel: string;
}
export interface ScreenState {
  scroll: number;
  toast: string | undefined;
  now: number;
  idle?: boolean;
}
export interface ScreenParts {
  editor: Editor;
  companion: CompanionRenderer;
}

export function renderScreen(
  view: FadeView, st: ScreenState, parts: ScreenParts, meta: UiMeta, width: number, rows: number,
): string[] {
  const fit = (lines: string[], height: number, columns = width): string[] =>
    Array.from({ length: height }, (_, i) => truncateToWidth(lines[i] ?? '', columns, '', true));
  if (width < MIN_WIDTH || rows < MIN_ROWS) {
    return fit(['Fade needs a slightly bigger window (60×16).'], rows).map(l => paintLine(l, width));
  }
  const folder = meta.cwd.split(/[\\/]/).filter(Boolean).pop() ?? meta.cwd;
  const left = ` ${c.mint('fade')} · ${c.text(sanitize(folder))} · ${c.muted(sanitize(meta.branch))}`;
  const header = left;
  const active = hasRail(view);
  const wide = active && width >= WIDE_WIDTH;
  const narrowStatus = active && !wide;
  const placeholder = st.idle && !active && view.companion.length > 0
    ? '› what would you like to do next?' : '› tell fade what you want…';
  const input = editorBlock(parts.editor, width, parts.editor.focused, placeholder);
  const height = Math.max(1, rows - 2 - input.length - 1 - (narrowStatus ? 1 : 0));
  const railWidth = wide ? Math.min(36, Math.floor(width * 0.3)) : 0;
  const conversationWidth = wide ? width - railWidth - 1 : width;
  const conversation = parts.companion.render(view, {
    width: conversationWidth, height, focused: true, scroll: st.scroll, now: st.now,
  });
  const right = wide ? rail(view, railWidth, st.now, height) : [];
  const body = fit(conversation, height, conversationWidth).map((line, i) => wide
    ? `${paintLine(line, conversationWidth)}${c.faint('│')}${right[i] ?? ''}` : line);
  const toast = st.toast ?? view.toast;
  const message = toast ? ` ${c.mint(sanitize(toast))}` : view.companionBusy ? c.muted(' fade is thinking…') : '';
  const footer = spread(message, c.faint('⏎ send · ? help '), width, visibleWidth);
  const lines = [
    header, c.faint('─'.repeat(width)), ...body,
    ...(narrowStatus ? [statusLine(view, st.now)] : []), ...input, footer,
  ];
  return fit(lines, rows).map(l => paintLine(l, width));
}
