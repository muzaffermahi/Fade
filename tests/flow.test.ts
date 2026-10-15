import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_CARD_MS, formatRunway, itemKey, LOW_RUNWAY_MS, nextItem, runwayMs, typicalCardMs, type NextInput,
} from '../src/flow.js';
import { Attention, QUIET_MS } from '../src/ui/attention.js';
import type { Card, Review } from '../src/types.js';
import type { FadeView } from '../src/view.js';

const card = (title: string, state: Card['state']): Card => ({ title, state, body: '' });
const review = (title: string, question?: string): Review => ({
  verdict: 'none', title, summary: 's', howToTry: '', files: [], finishedAt: 0, ...(question ? { question } : {}),
});
const MIN = 60_000;

test('typical card time: default with no history, median of the last five otherwise', () => {
  assert.equal(typicalCardMs([]), DEFAULT_CARD_MS);
  assert.equal(typicalCardMs([100 * MIN, 2 * MIN, 4 * MIN, 3 * MIN, 5 * MIN, 9 * MIN]), 4 * MIN);
  assert.equal(typicalCardMs([2 * MIN, 4 * MIN]), 3 * MIN);
});

test('runway: idle with nothing ready is zero; ready cards and the current card add up', () => {
  const now = 1_000_000;
  assert.equal(runwayMs({ cards: [card('a', 'draft')], buildingSince: null, durations: [], now }), 0);
  assert.equal(runwayMs({ cards: [card('a', 'ready'), card('b', 'ready')], buildingSince: null, durations: [4 * MIN], now }), 8 * MIN);
  const building = runwayMs({ cards: [card('a', 'building'), card('b', 'ready')], buildingSince: now - MIN, durations: [4 * MIN], now });
  assert.equal(building, 3 * MIN + 4 * MIN);
});

test('runway never claims under a minute while a slow card is still working', () => {
  const now = 10 * MIN;
  assert.equal(runwayMs({ cards: [card('a', 'building')], buildingSince: 0, durations: [MIN], now }), MIN);
});

test('runway formats as short, glanceable text', () => {
  assert.equal(formatRunway(45_000), '~45s');
  assert.equal(formatRunway(12 * MIN), '~12m');
  assert.equal(formatRunway(80 * MIN), '~1h20m');
});

function input(over: Partial<NextInput>): NextInput {
  return { cards: [], reviews: [], building: false, runwayMs: 0, ...over };
}

test('next: a blocked Builder outranks everything', () => {
  const item = nextItem(input({ reviews: [review('A'), review('B', 'old or new?')], freshDraft: 'X', cards: [card('X', 'draft')] }));
  assert.equal(item.kind, 'stuck');
});

test('next: the step you were just discussing outranks a landed review', () => {
  const item = nextItem(input({ reviews: [review('A')], freshDraft: 'X', cards: [card('A', 'review'), card('X', 'draft')] }));
  assert.deepEqual(item, { kind: 'fresh', title: 'X' });
});

test('next: a fresh draft that is already ready is no longer suggested', () => {
  const item = nextItem(input({ freshDraft: 'X', cards: [card('X', 'ready')], building: true, runwayMs: 20 * MIN }));
  assert.equal(item.kind, 'calm');
});

test('next: a landed step, then an idle Builder (with a draft to suggest), then a starving one', () => {
  assert.equal(nextItem(input({ reviews: [review('A'), review('B')] })).kind, 'review');
  assert.deepEqual(nextItem(input({ cards: [card('D', 'draft')] })), { kind: 'idle', draft: 'D' });
  assert.deepEqual(nextItem(input({})), { kind: 'idle' });
  const low = nextItem(input({ building: true, runwayMs: LOW_RUNWAY_MS - 1, cards: [card('B', 'building')] }));
  assert.equal(low.kind, 'low');
  assert.equal(nextItem(input({ building: true, runwayMs: LOW_RUNWAY_MS + 1 })).kind, 'calm');
  assert.equal(nextItem(input({ building: true, runwayMs: 1, cards: [card('R', 'ready')] })).kind, 'calm');
});

function view(over: Partial<FadeView>): FadeView {
  return {
    goal: '', cards: [], later: [], done: [], reviews: [], building: null, builderLog: [], companion: [],
    companionBusy: false, shippedToday: 0, progress: { done: 0, total: 0 }, runwayMs: 0,
    session: { startedAt: 0, shipped: [], commits: 0, idleMs: 0 }, bell: true, ...over,
  };
}

test('attention: new things wait while you type, then arrive at the breakpoint with one signal', () => {
  const signals: string[] = [];
  const attention = new Attention(item => signals.push(itemKey(item)));
  const calm = view({ building: { title: 'B', steps: [], action: '', startedAt: 0, liveText: '', lastMessage: '', notes: [] } });
  assert.equal(attention.resolve({ kind: 'calm' }, calm, false).kind, 'calm');
  const landed = view({ reviews: [review('A')] });
  const candidate = { kind: 'review' as const, review: review('A'), more: 0 };
  attention.keystroke(1000);
  assert.ok(attention.quiet(false, 1000 + QUIET_MS - 1));
  assert.equal(attention.resolve(candidate, landed, true).kind, 'calm', 'held back while typing');
  assert.deepEqual(signals, []);
  assert.ok(!attention.quiet(false, 1000 + QUIET_MS + 1));
  assert.equal(attention.resolve(candidate, landed, false).kind, 'review', 'arrives at the breakpoint');
  assert.equal(attention.resolve(candidate, landed, false).kind, 'review');
  assert.deepEqual(signals, ['review:A'], 'exactly one signal');
  assert.ok(attention.quiet(true, 999_999), 'text in the editor always counts as mid-thought');
});

test('attention: a shown item that gets resolved disappears even while you type', () => {
  const attention = new Attention(() => undefined);
  const candidate = { kind: 'review' as const, review: review('A'), more: 0 };
  attention.resolve(candidate, view({ reviews: [review('A')] }), false);
  assert.equal(attention.resolve({ kind: 'calm' }, view({}), true).kind, 'calm');
});

test('attention: nothing signals on the very first frame', () => {
  const signals: string[] = [];
  const attention = new Attention(item => signals.push(itemKey(item)));
  attention.resolve({ kind: 'idle' }, view({}), false);
  assert.deepEqual(signals, []);
});
