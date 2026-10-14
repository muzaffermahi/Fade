import assert from 'node:assert/strict';
import { test } from 'node:test';
import { visibleWidth } from '@earendil-works/pi-tui';
import { createHarness, type Harness, type Scenario } from '../scripts/headless.js';
import { dissolve } from '../src/ui/strip.js';
import { wordmark } from '../src/ui/logo.js';

const strip = (line: string): string =>
  line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b_[^\x07]*\x07/g, '');
const text = (h: Harness): string => h.render().map(strip).join('\n');

function checkGeometry(h: Harness, width: number, height: number): void {
  const lines = h.render();
  assert.equal(lines.length, height - 1, 'line count is rows - 1');
  lines.forEach((line, i) => assert.equal(visibleWidth(line), width, `line ${i} is ${width} columns`));
}

const sizes: [number, number][] = [[120, 40], [80, 24], [60, 16]];
const scenarios: Scenario[] = ['empty', 'building', 'review', 'idle'];

for (const [width, height] of sizes) {
  for (const scenario of scenarios) {
    test(`${scenario} renders cleanly at ${width}x${height}`, () => {
      const h = createHarness(scenario, width, height);
      checkGeometry(h, width, height);
      for (const focus of ['builder', 'companion', 'plan'] as const) {
        h.app.setFocus(focus);
        checkGeometry(h, width, height);
      }
      h.dispose();
    });
  }
}

test('too-small windows get a friendly message', () => {
  const h = createHarness('empty', 50, 12);
  checkGeometry(h, 50, 12);
  assert.match(text(h), /Fade needs a slightly bigger window \(60×16\)\./);
  h.dispose();
});

test('wide layout shows header, both panes, the strip and the hint line', () => {
  const h = createHarness('building', 120, 40);
  const out = text(h);
  for (const label of ['FADE', 'BUILDER', 'COMPANION', 'TO REVIEW', 'UP NEXT', 'shipped today 0', 'tab focus']) {
    assert.ok(out.includes(label), `has ${label}`);
  }
  assert.match(out, /◆ Core notes app · 1 file/);
  assert.match(out, /Read the project/);
  assert.match(out, /note to builder…/);
  h.dispose();
});

test('idle Builder with nothing ready says so', () => {
  const h = createHarness('idle', 120, 40);
  assert.match(text(h), /Builder is free\./);
  assert.match(text(h), /Builder is free: mark a card ready/);
  h.dispose();
});

test('plan focus grows the strip into a list with a selected row', () => {
  const h = createHarness('review', 120, 40);
  h.app.setFocus('plan');
  const out = text(h);
  assert.match(out, /PLAN/);
  assert.match(out, /›◆ Core notes app\s+review/);
  assert.match(out, /✓ Project setup/);
  h.dispose();
});

test('narrow layout shows tabs, one pane at a time', () => {
  const h = createHarness('building', 80, 24);
  h.app.setFocus('builder');
  assert.match(text(h), /Builder .*Companion.*Plan/);
  assert.ok(!text(h).includes('COMPANION'));
  h.app.setFocus('plan');
  assert.match(text(h), /PLAN/);
  h.dispose();
});

test('keys: tab cycles focus, space readies a draft', () => {
  const h = createHarness('review', 120, 40);
  h.app.setFocus('builder');
  h.app.handleInput('\t');
  assert.match(text(h), /COMPANION ●/);
  h.app.handleInput('\t');
  for (let i = 0; i < 3; i++) h.app.handleInput('j');
  h.app.handleInput(' ');
  assert.equal(h.fade.view().cards.find(c => c.title === 'Notebook styling')?.state, 'ready');
  h.dispose();
});

test('ctrl+c clears a typed line first, then needs a second press to quit', () => {
  let quits = 0;
  const h = createHarness('review', 120, 40, () => quits++);
  h.app.handleInput('h');
  h.app.handleInput('\x03');
  assert.equal(quits, 0);
  h.app.handleInput('\x03');
  assert.equal(quits, 0);
  assert.match(text(h), /Press Ctrl\+C again to quit/);
  h.app.handleInput('\x03');
  assert.equal(quits, 1);
  h.dispose();
});

test('typing in the Companion editor and pressing enter sends', async () => {
  const h = createHarness('review', 120, 40);
  h.app.setFocus('companion');
  for (const ch of 'hello') h.app.handleInput(ch);
  assert.match(text(h), /hello/);
  h.app.handleInput('\r');
  assert.equal(h.fade.view().companion.at(-1)?.text, 'hello');
  await new Promise(resolve => setTimeout(resolve, 1500));
  h.dispose();
});

test('a dissolving title loses characters right to left', () => {
  const start = strip(dissolve('Core notes app', 0));
  const mid = strip(dissolve('Core notes app', 0.5));
  const end = strip(dissolve('Core notes app', 1));
  assert.equal(start, 'Core notes app');
  assert.ok(mid.startsWith('Core') && mid !== start);
  assert.equal(end.trim(), '');
});

test('the wordmark is seven rows at wide widths and one line when narrow', () => {
  assert.equal(wordmark(120).length, 7);
  assert.equal(wordmark(60).length, 1);
  assert.notDeepEqual(wordmark(120, 1), wordmark(120, 2)); // twinkle changes the dust
});

test('streaming Companion text appears as it arrives and is then kept in the transcript', async () => {
  const h = createHarness('review', 120, 40);
  h.app.setFocus('companion');
  h.fade.sendToCompanion('tell me more');
  await new Promise(resolve => setTimeout(resolve, 150));
  const early = text(h);
  assert.match(early, /Good instinct/);
  assert.ok(!early.includes('make it a card'));
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.match(text(h), /Want me to turn that into a card\?/);
  h.dispose();
});

test('accepting a card dissolves its title before it disappears', async () => {
  const h = createHarness('review', 120, 40);
  h.app.setFocus('plan');
  h.app.handleInput('a');
  assert.equal(h.fade.view().done.at(-1)?.title, 'Core notes app');
  assert.match(text(h), /Shipped ✓/);
  const rowsWith = (re: RegExp): number => text(h).split('\n').filter(l => re.test(l)).length;
  assert.equal(rowsWith(/✓ Core notes app/), 2, 'dissolving row plus the new done entry');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.ok(text(h).split('\n').some(l => /✓ Core.*[▓▒░·]/.test(l)), 'dissolving mid-way');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(rowsWith(/✓ Core/), 1, 'only the done entry is left');
  h.dispose();
});

test('scrolling up in the Companion pane shows the "↓ new" hint, and sending jumps back', () => {
  const h = createHarness('review', 80, 24);
  h.app.setFocus('companion');
  for (let i = 0; i < 12; i++) h.fade.sendToCompanion(`message number ${i}`);
  assert.ok(!text(h).includes('↓ new'));
  h.app.handleInput('\x1b[5~'); // page up
  assert.match(text(h), /↓ new/);
  h.dispose();
});
