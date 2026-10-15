import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Check, Review, TranscriptEntry } from './types.js';

export interface FadeState {
  reviews: Review[];
  landedReviews: Review[];
  retried: string[];
  shipped: { date: string; count: number };
  companion: TranscriptEntry[];

}

const MAX_TRANSCRIPT = 200;

export function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function emptyState(): FadeState {
  return {
    reviews: [], landedReviews: [], retried: [], shipped: { date: today(), count: 0 }, companion: [],
  };
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function optionalText(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isCheck(value: unknown): value is Check {
  if (!isRecord(value) || typeof value.criterion !== 'string' || typeof value.passed !== 'boolean') return false;
  if (![value.evidence, value.proof, value.look].every(optionalText)) return false;
  const ran = value.ran;
  return ran === undefined || (isRecord(ran) && typeof ran.code === 'number' && typeof ran.tail === 'string'
    && typeof ran.ms === 'number' && optionalText(ran.sha));
}

function isReview(value: unknown): value is Review {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.summary !== 'string'
    || typeof value.howToTry !== 'string' || typeof value.finishedAt !== 'number') return false;
  if (typeof value.verdict !== 'string'
    || !['verified', 'look', 'failed', 'said', 'unfinished', 'none'].includes(value.verdict)) return false;
  if (![value.sha, value.question, value.tryCommand].every(optionalText)) return false;
  if (!Array.isArray(value.files) || !value.files.every(f => typeof f === 'string')) return false;
  if (value.doneWhen !== undefined
    && (!Array.isArray(value.doneWhen) || !value.doneWhen.every(s => typeof s === 'string'))) return false;
  return value.checks === undefined || (Array.isArray(value.checks) && value.checks.every(isCheck));
}

function parseState(text: string): FadeState {
  const state = emptyState();
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) return state;
  // NOTE: the file is written only by Fade; we trust the shape after these array/object checks.
  if (Array.isArray(raw.reviews)) state.reviews = raw.reviews as Review[];
  if (Array.isArray(raw.companion)) state.companion = raw.companion as TranscriptEntry[];
  if (Array.isArray(raw.landedReviews)) state.landedReviews = raw.landedReviews.filter(isReview);
  const shipped = raw.shipped;
  if (isRecord(shipped) && typeof shipped.date === 'string' && typeof shipped.count === 'number') {
    state.shipped = { date: shipped.date, count: shipped.count };
  }
  state.retried = strings(raw.retried);
  for (const review of state.reviews) review.verdict ??= 'said';
  return state;
}

export class StateStore {
  readonly dir: string;
  readonly path: string;
  data: FadeState = emptyState();

  constructor(cwd: string) {
    this.dir = join(cwd, '.fade');
    this.path = join(this.dir, 'state.json');
  }

  load(): FadeState {
    try {
      if (existsSync(this.path)) this.data = parseState(readFileSync(this.path, 'utf8'));
    } catch {
      this.data = emptyState(); // a damaged state file is not worth crashing for
    }
    this.rollDate();
    return this.data;
  }

  rollDate(): void {
    if (this.data.shipped.date !== today()) this.data.shipped = { date: today(), count: 0 };
  }

  save(): void {
    this.data.companion = this.data.companion.slice(-MAX_TRANSCRIPT);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
