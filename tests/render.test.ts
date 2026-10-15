import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Editor, TuiMainScreen, visibleWidth } from '@earendil-works/pi-tui';
import { createHarness, FakeTerminal, type Scenario } from '../scripts/headless.js';
import { CompanionRenderer } from '../src/ui/companion-pane.js';
import { rail } from '../src/ui/rail.js';
import { ShowOverlay } from '../src/ui/overlays.js';
import { Splash } from '../src/ui/splash.js';
import { renderScreen } from '../src/ui/screen.js';
import { editorTheme } from '../src/ui/overlays.js';
import type { Review } from '../src/types.js';
const strip = (line: string): string => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b_[^\x07]*\x07/g, '');
for (const [width, height] of [[120, 40], [80, 24], [60, 16]] as const) {
  for (const scenario of ['empty', 'building', 'review', 'idle'] as Scenario[]) {
    test(`v0.4 ${scenario} at ${width}×${height}: one conversation and bounded geometry`, () => {
      const h = createHarness(scenario, width, height);
      try {
        const lines = h.render();
        assert.equal(lines.length, height - 1);
        lines.forEach(l => assert.equal(visibleWidth(l), width));
        const out = lines.map(strip).join('\n');
        assert.doesNotMatch(out, /said, not run|runway|Tab|tab focus|COMPANION|shipped today|▐█/);
        assert.match(strip(lines[0] ?? ''), /fade/);
        assert.match(out, scenario === 'building' ? /keep talking/ : /tell fade what you want/);
        const hint = strip(lines.at(-1) ?? '');
        assert.ok(hint.split(' · ').length <= 4);
        if (width >= 100) {
          // The sidebar never closes: the Builder, what's next and what needs you are always in view.
          for (const section of ['BUILDER', 'UP NEXT', 'NEEDS YOU']) assert.ok(out.includes(section), section);
          if (scenario === 'empty') assert.match(out, /While it builds, keep/);
        } else {
          assert.doesNotMatch(out, /BUILDER|NEEDS YOU/);
          assert.match(out, scenario === 'building' ? /builder ◌/ : /builder idle/);
          if (scenario === 'review' || scenario === 'idle') assert.match(out, /\d needs you/);
        }
        assert.doesNotMatch(out, /Goal:|Goal done:|· draft|· review/);
      } finally { h.dispose(); }
    });
  }
  test(`v0.4 Show at ${width}×${height}: read only, real output for passing and failed proofs`, () => {
    const review: Review = { title: 'Checks', verdict: 'failed', summary: 'A mixed result.', howToTry: '', files: [], finishedAt: 0, sha: 'abc',
      doneWhen: ['proved', 'failed', 'claimed', 'taste', 'omitted'], checks: [
        { criterion: 'proved', passed: true, proof: 'test', ran: { code: 0, tail: 'PASS OUTPUT', ms: 1, sha: 'abc' } },
        { criterion: 'failed', passed: true, proof: 'test', ran: { code: 1, tail: 'FAIL OUTPUT', ms: 1, sha: 'abc' } },
        { criterion: 'claimed', passed: true }, { criterion: 'taste', passed: true, look: 'Calmer?' },
      ] };
    const overlay = new ShowOverlay(() => height, review, [], 'diff --git real.diff', () => undefined);
    let out = '';
    for (let i = 0; i < 30; i++) {
      const lines = overlay.render(width);
      lines.forEach(l => assert.ok(visibleWidth(l) <= width));
      out += lines.map(strip).join('\n');
      overlay.handleInput('a'); // no action or mutation
      overlay.handleInput('\x1b[6~');
    }
    for (const expected of ['✓ proved', '✗ failed', 'PASS OUTPUT', 'FAIL OUTPUT', 'could not run', 'Calmer?', 'not addressed', 'real.diff']) assert.ok(out.includes(expected), expected);
    assert.doesNotMatch(out, /said, not run|a accept|d diff/);
  });
}
test('v0.4 empty enter does nothing, typing sends, ctrl+c warns before quitting', () => {
  let quits = 0;
  const h = createHarness('empty', 80, 24, () => quits++);
  try {
    h.app.handleInput('\r');
    assert.equal(h.fade.view().companion.length, 0);
    for (const ch of 'hello') h.app.handleInput(ch);
    h.app.handleInput('\r');
    assert.equal(h.fade.view().companion[0]?.text, 'hello');
    h.app.handleInput('\x03');
    assert.equal(quits, 0);
    assert.match(h.render().map(strip).join('\n'), /Ctrl\+C again/);
    h.app.handleInput('\x03');
    assert.equal(quits, 1);
  } finally { h.dispose(); }
});

test('final pass: work never changes conversation wrapping or message spacing', () => {
  const h = createHarness('building', 120, 40);
  try {
    const view = h.fade.view();
    view.companion = [{ role: 'companion', text: 'A steady conversation. '.repeat(200) + '\n\nOne message.' }];
    const parts = {
      editor: new Editor(new TuiMainScreen(new FakeTerminal(120, 40)), editorTheme()),
      companion: new CompanionRenderer(),
    };
    const meta = { cwd: h.cwd, branch: 'main', builderModel: 'demo', companionModel: 'demo' };
    const state = { scroll: 0, toast: undefined, now: 1000 };
    const active = renderScreen(view, state, parts, meta, 120, 39).slice(2, 33);
    const idle = renderScreen({ ...view, building: null, reviews: [] }, state, parts, meta, 120, 39).slice(2, 33);
    assert.deepEqual(active.map(line => strip(line).slice(0, 88)), idle.map(line => strip(line).slice(0, 88)));
    const message = parts.companion.transcriptLines(view, 88).map(strip);
    assert.ok(message.every(line => line.trim()), 'no blank lines inside one message');
  } finally { h.dispose(); }
});
test('v0.4 no focus switching or action keys: space and u are ordinary input', () => {
  const h = createHarness('review', 120, 40);
  try {
    h.app.handleInput('\t');
    h.app.handleInput('u'); h.app.handleInput(' ');
    assert.match(h.render().map(strip).join('\n'), /u /);
    assert.equal(h.fade.view().reviews.length, 1);
  } finally { h.dispose(); }
});
test('polish: the sidebar stays open when idle and historical state stays hidden', () => {
  const h = createHarness('empty', 120, 40);
  try {
    h.fade.model.plan.cards.push({ title: 'Private proposal', state: 'draft', body: 'Repeated body.' });
    h.fade.sendToCompanion('hello');
    h.app.handleInput('typing');
    h.app.ctrlC();
    const out = h.render().map(strip).join('\n');
    assert.doesNotMatch(out, /typing|Legacy goal|progress/);
    assert.match(out, /BUILDER[\s\S]*Idle/);
    assert.match(out, /Private proposal \(say yes\)/);
  } finally { h.dispose(); }
});

test('polish: rail paths wrap with hanging indentation and empty sections explain themselves', () => {
  const h = createHarness('building', 120, 40);
  try {
    const view = h.fade.view();
    assert.ok(view.building);
    view.building.steps = [{ text: 'Read ' + 'long/'.repeat(30) + 'module.py', status: 'active' }];
    view.building.action = 'editing ' + 'long/'.repeat(30) + 'module.py';
    view.reviews = [];
    view.cards = [];
    const lines = rail(view, 32, Date.now(), 50).map(strip);
    lines.forEach(line => assert.ok(visibleWidth(line) <= 32, line));
    assert.match(lines.join('\n'), /module.py/);
    assert.match(lines.join('\n'), /UP NEXT[\s\S]*Keep talking while it/);
    assert.match(lines.join('\n'), /NEEDS YOU[\s\S]*Nothing/);
    const step = lines.findIndex(line => line.includes('◌ Read'));
    assert.ok(lines[step + 1]?.startsWith('     '));
    const action = lines.findIndex(line => line.includes('└ editing'));
    assert.ok(lines[action + 1]?.startsWith('       '));
  } finally { h.dispose(); }
});

test('polish: historical internal entries remain hidden and idle only changes the placeholder', () => {
  const h = createHarness('empty', 120, 40);
  try {
    const view = h.fade.view();
    view.companion = [
      { role: 'you', text: 'Keep working.' },
      { role: 'card', text: 'INTERNAL DRAFT' },
      { role: 'goal', text: 'OLD GOAL' },
      { role: 'landed', text: 'Goal done: 1 step in 0m.' },
    ];
    const lines = new CompanionRenderer().transcriptLines(view, 120).map(strip).join('\n');
    assert.match(lines, /Keep working/);
    assert.doesNotMatch(lines, /INTERNAL|GOAL|Goal done/);
  } finally { h.dispose(); }
});

test('polish: an expired quit warning requires a fresh double press', t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  let quits = 0;
  const h = createHarness('empty', 80, 24, () => quits++);
  try {
    h.app.ctrlC();
    now += 2000;
    h.app.ctrlC();
    assert.equal(quits, 0);
    h.app.ctrlC();
    assert.equal(quits, 1);
  } finally { h.dispose(); }
});

test('polish: idle changes only the placeholder, without a model turn', async t => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const h = createHarness('empty', 80, 24);
  try {
    h.fade.sendToCompanion('hello');
    await new Promise(resolve => setTimeout(resolve, 1000));
    const entries = h.fade.view().companion.length;
    now += 61000;
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.match(h.render().map(strip).join('\n'), /what would you like to do next/);
    assert.equal(h.fade.view().companion.length, entries);
    assert.equal(h.fade.view().companionBusy, false);
  } finally { h.dispose(); }
});

test('polish: splash requires two Ctrl+C presses too', () => {
  let quits = 0;
  const splash = new Splash(new TuiMainScreen(new FakeTerminal(80, 24)), () => undefined, () => quits++);
  try {
    splash.handleInput('\x03');
    assert.equal(quits, 0);
    assert.match(splash.render(80).map(strip).join('\n'), /Ctrl\+C again/);
    splash.handleInput('\x03');
    assert.equal(quits, 1);
  } finally { splash.dispose(); }
});
