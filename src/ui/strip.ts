import { c, sanitize } from './theme.js';

export const FADE_MS = 700;

const DUST = ['▓', '▒', '░', '·', ' '];

/** Right-to-left dissolve: ▓ ▒ ░ · while the color drifts ivory → mint → lavender → faint. */
export function dissolve(title: string, progress: number): string {
  const chars = [...sanitize(title)];
  const n = chars.length;
  const paint = progress < 0.25 ? c.text : progress < 0.5 ? c.mint : progress < 0.75 ? c.lavender : c.faint;
  const out = chars.map((ch, i) => {
    const age = progress * (n + 4) - (n - 1 - i);
    if (age <= 0) return ch;
    return DUST[Math.min(DUST.length - 1, Math.floor(age))] ?? ' ';
  });
  return paint(out.join(''));
}
