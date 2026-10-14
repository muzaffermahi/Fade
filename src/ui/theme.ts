import { truncateToWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';

export const PALETTE = {
  bg: '#121416',
  text: '#F5F4DE',
  mint: '#A6EFDC',
  lavender: '#BE9EF0',
  muted: '#A4ABBE',
  faint: '#5C6370',
  rose: '#F2A7A7',
} as const;

export const GLYPH = { draft: '·', ready: '○', building: '◌', review: '◆', done: '✓' } as const;
export const SPINNER = ['◜', '◠', '◝', '◞', '◡', '◟'] as const;
export const SPINNER_MS = 100;

const PLAIN = process.env.NO_COLOR !== undefined;

export type Paint = (text: string) => string;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function fg(hex: string): Paint {
  if (PLAIN) return text => text;
  const [r, g, b] = rgb(hex);
  return text => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function bg(hex: string): Paint {
  if (PLAIN) return text => text;
  const [r, g, b] = rgb(hex);
  return text => `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
}

export const bold: Paint = text => (PLAIN ? text : `\x1b[1m${text}\x1b[22m`);
export const dim: Paint = text => (PLAIN ? text : `\x1b[2m${text}\x1b[22m`);
export const underline: Paint = text => (PLAIN ? text : `\x1b[4m${text}\x1b[24m`);

export const c = {
  text: fg(PALETTE.text),
  mint: fg(PALETTE.mint),
  lavender: fg(PALETTE.lavender),
  muted: fg(PALETTE.muted),
  faint: fg(PALETTE.faint),
  rose: fg(PALETTE.rose),
};

const BG = PLAIN ? '' : bg(PALETTE.bg)('').slice(0, -5); // just the "set background" escape

/** Fits a line to exactly `width` columns and paints the app background behind it. */
export function paintLine(line: string, width: number): string {
  const fitted = truncateToWidth(line, width, '…', true);
  if (PLAIN) return fitted;
  const kept = fitted.replaceAll('\x1b[0m', `\x1b[0m${BG}`).replaceAll('\x1b[49m', `\x1b[49m${BG}`);
  return `${BG}${kept}\x1b[49m`;
}

/** Strips ANSI and control characters from model output. Keeps newlines and tabs. */
export function sanitize(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

/** Keeps only SGR (color) escapes; for showing `git show --color=always` output. */
export function keepColorsOnly(text: string): string {
  return text
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-ln-~]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g, '')
    .replace(/\r/g, '');
}

/** Sanitizes then word-wraps to `width`, preserving blank lines. */
export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const raw of sanitize(text).replaceAll('\t', '  ').split('\n')) {
    if (raw.trim() === '') lines.push('');
    else lines.push(...wrapTextWithAnsi(raw, Math.max(1, width)));
  }
  return lines;
}

export function spinnerFrame(now = Date.now()): string {
  return SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length] ?? '◜';
}

export function clock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 60))}:${pad(total % 60)}`;
}

/** Left text, then right text pushed to the right edge (right is dropped if there's no room). */
export function spread(left: string, right: string, width: number, visible: (s: string) => number): string {
  const gap = width - visible(left) - visible(right);
  return gap >= 1 ? left + ' '.repeat(gap) + right : left;
}
