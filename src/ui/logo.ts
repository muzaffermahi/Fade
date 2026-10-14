import { bold, fg, PALETTE } from './theme.js';

const LETTERS = [
  ['11111', '11111', '11000', '11110', '11110', '11000', '11000'], // F
  ['011110', '111111', '110011', '111111', '111111', '110011', '110011'], // A
  ['111110', '111111', '110011', '110011', '110011', '111111', '111110'], // D
  ['11111', '11110', '11000', '11111', '11010', '11111', '11111'], // E (already breaking apart)
];
const TRAIL = [
  'M  M  M    M    M   M           ',
  ' M  M   M     M    L    M       ',
  'M  M   M  M      L    L      L  ',
  ' M   M   M   M    L      L      ',
  'M   M   M   M   L    L     L    ',
  '  M   M    M   M   L   L    M   ',
  'M   M   M    M   L    L   L     ',
];
const NEAR_EDGE = [' ', 'M', ' ', 'M', ' ', 'M', ' '];
const NEAR_TRAIL = ['M M ', ' M M', 'M M ', ' MM ', 'M M ', ' M M', 'M M '];

const IVORY = fg(PALETTE.text);
const MINT = fg(PALETTE.mint);
const LAVENDER = fg(PALETTE.lavender);
const NO_COLOR = process.env.NO_COLOR !== undefined;

/** Two columns per tile: a half block plus a full block, with a bg-colored underline for the row gap. */
function tile(color: (s: string) => string, bgRgb = '18;20;22'): string {
  if (NO_COLOR) return '▐█';
  return color(`\x1b[4m\x1b[58;2;${bgRgb}m▐█\x1b[24m\x1b[59m`);
}

/** Cheap deterministic hash in [0, 1). */
function hash(row: number, col: number, seed: number): number {
  let h = Math.imul(row + 1, 374761393) + Math.imul(col + 1, 668265263) + Math.imul(seed + 1, 2147483629);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

type Dust = 'M' | 'L' | ' ';

/** Shimmer: ~8% of dust tiles swap color or blink out. */
function twinkle(kind: Dust, row: number, col: number, seed: number | undefined): Dust {
  if (seed === undefined || kind === ' ') return kind;
  const r = hash(row, col, seed);
  if (r < 0.04) return kind === 'M' ? 'L' : 'M';
  if (r < 0.08) return ' ';
  return kind;
}

function dustTile(kind: Dust): string {
  if (kind === 'M') return tile(MINT);
  if (kind === 'L') return tile(LAVENDER);
  return '  ';
}

/** 7 rows. Each letter cell is one tile (2 columns); letters are separated by one empty tile. */
export function wordmark(width: number, twinkleSeed?: number): string[] {
  if (width < 76) return [compactMark()];
  const trailTiles = Math.min(32, Math.max(0, Math.floor(width / 2) - 26));
  return LETTERS[0]!.map((_, row) => {
    const letters = LETTERS.map((letter, i) =>
      [...letter[row]!].map(ch => (ch === '0' ? '  ' : tile(i < 3 ? IVORY : MINT))).join(''),
    ).join('  ');
    const near = NEAR_TRAIL[row]!;
    const trail = [...(near + TRAIL[row]!.slice(near.length))]
      .slice(0, trailTiles)
      .map((ch, col) => dustTile(twinkle(ch === 'M' ? 'M' : ch === 'L' ? 'L' : ' ', row, col, twinkleSeed)))
      .join('');
    const edge: Dust = NEAR_EDGE[row] === 'M' ? 'M' : ' ';
    return letters + dustTile(twinkle(edge, row, 99, twinkleSeed)) + trail;
  });
}

/** One line for headers: "FADE" plus a tiny dissolving trail. */
export function compactMark(): string {
  return bold(IVORY('FAD')) + bold(MINT('E')) + MINT(' ▪ ▪') + LAVENDER(' ▫  ·');
}
