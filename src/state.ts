import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Review, TranscriptEntry } from './types.js';

export interface FadeState {
  reviews: Review[];
  shipped: { date: string; count: number };
  companion: TranscriptEntry[];
  /** How long recent cards took to build, in ms, newest last. Feeds the runway estimate. */
  durations: number[];
  /** Titles shipped under the current goal, for the progress line and the closure card. */
  goalShipped: string[];
  goalStartedAt: number;
  /** Ring the terminal bell when something new needs you. */
  bell: boolean;
}

const MAX_TRANSCRIPT = 200;
const MAX_DURATIONS = 20;

export function today(): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function emptyState(): FadeState {
  return {
    reviews: [], shipped: { date: today(), count: 0 }, companion: [],
    durations: [], goalShipped: [], goalStartedAt: Date.now(), bell: true,
  };
}

function numbers(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((n): n is number => typeof n === 'number' && Number.isFinite(n)) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseState(text: string): FadeState {
  const state = emptyState();
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) return state;
  // NOTE: the file is written only by Fade; we trust the shape after these array/object checks.
  if (Array.isArray(raw.reviews)) state.reviews = raw.reviews as Review[];
  if (Array.isArray(raw.companion)) state.companion = raw.companion as TranscriptEntry[];
  const shipped = raw.shipped;
  if (isRecord(shipped) && typeof shipped.date === 'string' && typeof shipped.count === 'number') {
    state.shipped = { date: shipped.date, count: shipped.count };
  }
  state.durations = numbers(raw.durations).slice(-MAX_DURATIONS);
  state.goalShipped = strings(raw.goalShipped);
  if (typeof raw.goalStartedAt === 'number') state.goalStartedAt = raw.goalStartedAt;
  if (typeof raw.bell === 'boolean') state.bell = raw.bell;
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

  recordDuration(ms: number): void {
    this.data.durations = [...this.data.durations, ms].slice(-MAX_DURATIONS);
  }

  save(): void {
    this.data.companion = this.data.companion.slice(-MAX_TRANSCRIPT);
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    renameSync(tmp, this.path);
  }
}
