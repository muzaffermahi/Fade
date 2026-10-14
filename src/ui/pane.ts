import { CURSOR_MARKER, type Editor } from '@earendil-works/pi-tui';
import { c, spread } from './theme.js';
import { visibleWidth } from '@earendil-works/pi-tui';

export interface PaneOptions {
  width: number;
  height: number;
  focused: boolean;
  /** Lines scrolled up from the bottom; 0 follows the newest content. */
  scroll: number;
  now: number;
}

/** The editor's own lines, with the cursor hidden when unfocused and a placeholder when empty. */
export function editorBlock(editor: Editor, width: number, focused: boolean, placeholder: string): string[] {
  const lines = editor.render(width);
  if (editor.getText() === '' && lines.length === 3) {
    const cursor = focused ? `${CURSOR_MARKER}\x1b[7m \x1b[0m` : ' ';
    lines[1] = ` ${cursor}${c.faint(placeholder)}`;
  } else if (!focused) {
    return lines.map(line => line.replace(CURSOR_MARKER, '').replace('\x1b[7m \x1b[0m', ' '));
  }
  return lines;
}

export function paneHeader(
  name: string, color: (s: string) => string, focused: boolean, title: string, right: string, width: number,
): string {
  const dot = focused ? ` ${c.mint('●')}` : '';
  return spread(` ${color(name)}${dot}${title}`, `${right} `, width, visibleWidth);
}

export interface Viewport {
  lines: string[];
  /** True when the user has scrolled above the newest content. */
  behind: boolean;
}

/** Shows `height` lines of `content`, ending `scroll` lines above the bottom. Pads with blanks. */
export function viewport(content: string[], height: number, scroll: number): Viewport {
  if (content.length <= height) return { lines: [...content, ...Array(height - content.length).fill('')], behind: false };
  const maxScroll = content.length - height;
  const offset = Math.min(Math.max(0, scroll), maxScroll);
  const end = content.length - offset;
  return { lines: content.slice(end - height, end), behind: offset > 0 };
}

export function withNewHint(lines: string[], behind: boolean, width: number): string[] {
  if (!behind || lines.length === 0) return lines;
  const out = [...lines];
  out[out.length - 1] = spread(out[out.length - 1] ?? '', c.faint('↓ new '), width, visibleWidth);
  return out;
}
