import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBuilder, FakeCompanion } from '../src/agents/fake.js';
import { companionPlanApi } from '../src/assemble.js';
import { Git } from '../src/git.js';
import { COMPANION_TOOLS } from '../src/agents/companion.js';
import { formatCompanionContext } from '../src/agents/prompts.js';
import { Fade, titleFromText } from '../src/loop.js';
import { parsePlan, PlanStore } from '../src/plan.js';
import { StateStore } from '../src/state.js';

function makeRepo(plan: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fade-test-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'README.md'), 'hi\n');
  writeFileSync(join(cwd, 'PLAN.md'), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return cwd;
}

function makeFade(cwd: string, builder?: FakeBuilder): Fade {
  const plans = new PlanStore(cwd);
  const state = new StateStore(cwd);
  const git = new Git(cwd);
  git.excludeFade();
  const fadeRef: { current?: Fade } = {};
  const api = companionPlanApi(() => {
    if (!fadeRef.current) throw new Error('not ready');
    return fadeRef.current;
  });
  const fade = new Fade({
    cwd, plans, state, git,
    builder: builder ?? new FakeBuilder(cwd, { speed: 100000 }),
    companion: new FakeCompanion(api, { speed: 100000 }),
  });
  fadeRef.current = fade;
  return fade;
}

async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const states = (fade: Fade): string[] => fade.view().cards.map(c => `${c.state}:${c.title}`);
const log = (cwd: string): string[] =>
  execFileSync('git', ['log', '--format=%s'], { cwd, encoding: 'utf8' }).trim().split('\n');
const planOnDisk = (cwd: string) => parsePlan(readFileSync(join(cwd, 'PLAN.md'), 'utf8'));

test('toggleReady: draft -> ready starts the build; ready -> draft cancels', async () => {
  const cwd = makeRepo('## [draft] One\n\n## [draft] Two\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.toggleReady('Two');
  assert.deepEqual(states(fade), ['draft:One', 'building:Two']);
  await fade.stopBuilder();
  await until(() => fade.view().building === null);
  fade.toggleReady('One');
  assert.equal(fade.view().building?.title, 'One');
  fade.dispose();
});

test('a ready card builds, is checkpointed, and lands in review', async () => {
  const cwd = makeRepo('## [ready] Alpha\nMake alpha.\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1, 'review');
  const view = fade.view();
  assert.equal(view.cards[0]?.state, 'review');
  const review = view.reviews[0];
  assert.ok(review?.sha);
  assert.ok(review?.files.some(f => f.includes('fade-demo')));
  assert.equal(log(cwd)[0], 'fade: Alpha');
  assert.equal(planOnDisk(cwd).cards[0]?.state, 'review');
  fade.dispose();
});

test('the Builder takes the topmost ready card, then the next one', async () => {
  const cwd = makeRepo('## [draft] Skip me\n\n## [ready] First\n\n## [ready] Second\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 2, 'two reviews');
  assert.deepEqual(states(fade), ['draft:Skip me', 'review:First', 'review:Second']);
  assert.deepEqual(log(cwd).slice(0, 2), ['fade: Second', 'fade: First']);
  fade.dispose();
});

test('tick never starts a second build', async () => {
  const cwd = makeRepo('## [ready] A\n\n## [ready] B\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.tick();
  fade.tick();
  assert.deepEqual(states(fade), ['building:A', 'ready:B']);
  await fade.stopBuilder();
  fade.dispose();
});

test('stuck: goes to review with the question and a partial checkpoint', async () => {
  const cwd = makeRepo('## [ready] I am stuck\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1, 'stuck review');
  assert.match(fade.view().reviews[0]?.question ?? '', /old format/);
  assert.equal(log(cwd)[0], 'fade: I am stuck (partial)');
  fade.dispose();
});

test('stopped: back to draft at the top, partial work saved, note appended', async () => {
  const cwd = makeRepo('## [draft] Other\n\n## [ready] Slow\nbody\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 20 }));
  fade.start();
  await until(() => existsSync(join(cwd, 'fade-demo')), 'partial work');
  await fade.stopBuilder();
  await until(() => fade.view().building === null, 'stopped');
  const view = fade.view();
  assert.deepEqual(view.cards.map(c => `${c.state}:${c.title}`), ['draft:Slow', 'draft:Other']);
  assert.match(view.cards[0]?.body ?? '', /> Stopped partway\./);
  assert.equal(log(cwd)[0], 'fade: Slow (partial)');
  fade.dispose();
});

test('failed: draft at the top, error shown, no retry', async () => {
  const cwd = makeRepo('## [ready] Boom\n\n## [ready] After\n');
  const failing = new FakeBuilder(cwd, { speed: 100000 });
  failing.build = async () => ({ kind: 'failed', error: 'no model configured' });
  const fade = makeFade(cwd, failing);
  fade.start();
  await until(() => fade.view().builderError !== undefined, 'error');
  const view = fade.view();
  assert.equal(view.builderError, 'no model configured');
  assert.equal(view.cards[0]?.state, 'draft');
  assert.match(view.cards[0]?.body ?? '', /> Failed: no model configured/);
  assert.equal(view.cards[1]?.state, 'ready');
  assert.equal(view.building, null);
  fade.dispose();
});

test('accept: review -> done with sha, counter goes up', async () => {
  const cwd = makeRepo('## [ready] Alpha\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1);
  const sha = fade.view().reviews[0]?.sha;
  fade.accept('Alpha');
  const view = fade.view();
  assert.equal(view.cards.length, 0);
  assert.deepEqual(view.done, [{ title: 'Alpha', sha }]);
  assert.equal(view.reviews.length, 0);
  assert.equal(view.shippedToday, 1);
  assert.equal(view.toast, 'Shipped ✓');
  assert.match(readFileSync(join(cwd, 'PLAN.md'), 'utf8'), /## Done\n- Alpha \(/);
  fade.dispose();
});

test('revise: back to ready at the top with the note, and rebuilds', async () => {
  const cwd = makeRepo('## [ready] Alpha\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1);
  fade.revise('Alpha', 'make it blue');
  await until(() => log(cwd).filter(s => s === 'fade: Alpha').length === 2, 'second checkpoint');
  await until(() => fade.view().reviews.length === 1 && fade.view().building === null);
  assert.match(fade.view().cards[0]?.body ?? '', /> Revise: make it blue/);
  fade.dispose();
});

test('undo: removes the card and queues an Undo card that builds', async () => {
  const cwd = makeRepo('## [ready] Alpha\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1);
  const sha = fade.view().reviews[0]?.sha;
  fade.undo('Alpha');
  assert.equal(fade.view().cards[0]?.title, 'Undo: Alpha');
  assert.match(fade.view().cards[0]?.body ?? '', new RegExp(`commit ${sha}`));
  await until(() => fade.view().reviews.some(r => r.title === 'Undo: Alpha'), 'undo review');
  assert.ok(!fade.view().cards.some(c => c.title === 'Alpha'));
  fade.dispose();
});

test('drop removes draft, ready and review cards (not the building one)', async () => {
  const cwd = makeRepo('## [ready] B\n\n## [draft] D\n\n## [ready] R\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.drop('R');
  assert.deepEqual(states(fade), ['building:B', 'draft:D']);
  fade.drop('D');
  fade.drop('B');
  assert.deepEqual(states(fade), ['building:B']);
  await fade.stopBuilder();
  fade.dispose();
});

test('sendToBuilder: idle makes a ready card at the top; building forwards a note', async () => {
  const cwd = makeRepo('## [draft] Existing\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.sendToBuilder('Add a footer to every page so people can find the contact link easily');
  const view = fade.view();
  assert.equal(view.building?.title, 'Add a footer to every page so people can find');
  assert.match(view.cards[0]?.body ?? '', /contact link easily$/);
  fade.sendToBuilder('use blue');
  assert.deepEqual(fade.view().building?.notes, ['use blue']);
  assert.equal(fade.view().cards.length, 2);
  await fade.stopBuilder();
  fade.dispose();
});

test('startup recovery: building -> ready (keeps position) and orphan reviews are dropped', async () => {
  const cwd = makeRepo('## [draft] A\n\n## [building] B\n\n## [draft] C\n');
  mkdirSync(join(cwd, '.fade'), { recursive: true });
  writeFileSync(join(cwd, '.fade', 'state.json'), JSON.stringify({
    reviews: [{ title: 'Gone', summary: 's', howToTry: '', files: [], finishedAt: 1 }],
    shipped: { date: '2000-01-01', count: 5 }, companion: [],
  }));
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  assert.equal(fade.view().shippedToday, 0);
  fade.start();
  assert.deepEqual(states(fade), ['draft:A', 'building:B', 'draft:C']);
  assert.equal(fade.view().reviews.length, 0);
  await fade.stopBuilder();
  fade.dispose();
});

test('external PLAN.md edits are picked up; the building card stays building', async () => {
  const cwd = makeRepo('## [ready] Work\n\n## [draft] Idea\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  writeFileSync(join(cwd, 'PLAN.md'), '## [ready] Work\n\n## [draft] Idea\n\n## [draft] Added by hand\n');
  await until(() => fade.view().cards.length === 3, 'reload');
  assert.equal(fade.view().cards[0]?.state, 'building');
  writeFileSync(join(cwd, 'PLAN.md'), '## [draft] Idea\n');
  await until(() => fade.view().cards.length === 1, 'reload without building card');
  await fade.stopBuilder();
  await until(() => fade.view().building === null);
  assert.equal(fade.view().cards[0]?.title, 'Work'); // re-inserted at the top
  fade.dispose();
});

test('companion messages and cards land in the transcript and plan', async () => {
  const cwd = makeRepo('## [draft] Existing\n');
  const fade = makeFade(cwd);
  fade.start();
  fade.sendToCompanion('please make a card for dark mode');
  await until(() => fade.view().cards.some(c => c.state === 'draft' && c.title !== 'Existing'), 'card');
  await until(() => !fade.view().companionBusy);
  const roles = fade.view().companion.map(e => e.role);
  assert.deepEqual(roles.slice(0, 2), ['you', 'companion']);
  assert.ok(roles.includes('card'));
  assert.ok(JSON.parse(readFileSync(join(cwd, '.fade', 'state.json'), 'utf8')).companion.length >= 3);
  fade.dispose();
});

test('titleFromText trims at a word boundary', () => {
  assert.equal(titleFromText('short'), 'short');
  assert.ok(titleFromText('word '.repeat(30)).length <= 48);
});

test('the Companion only gets read-only built-in tools plus the card tools', () => {
  for (const banned of ['edit', 'write', 'bash']) assert.ok(!COMPANION_TOOLS.includes(banned), banned);
  assert.deepEqual(COMPANION_TOOLS.filter(name => !name.startsWith('fade_')), ['read', 'grep', 'find', 'ls']);
});

test('the Companion context lists the build, reviews, plan and recent work', async () => {
  const cwd = makeRepo('## [building] Search\n\n## [review] Done thing\n\n## [draft] Idea\n\n## Done\n- Old one\n');
  const fade = makeFade(cwd);
  const context = formatCompanionContext(fade.view());
  assert.match(context, /Builder idle/);
  assert.match(context, /\[building\] Search/);
  assert.match(context, /\[draft\] Idea/);
  assert.match(context, /Recently done: Old one/);
  fade.dispose();
});

test('the Companion transcript is restored after a restart', async () => {
  const cwd = makeRepo('## [draft] Existing\n');
  const first = makeFade(cwd);
  first.start();
  first.sendToCompanion('hello there');
  await until(() => first.view().companion.some(e => e.role === 'companion'), 'reply');
  await until(() => !first.view().companionBusy);
  first.dispose();
  const second = makeFade(cwd);
  assert.equal(second.view().companion[0]?.text, 'hello there');
  second.dispose();
});


test('proofs: a contradicted claim retries exactly once and then shows real output', async () => {
  const cwd = makeRepo('## [ready] Honest\nDone when: it works.\n');
  const builder = new FakeBuilder(cwd);
  let attempts = 0;
  builder.build = async card => {
    attempts++;
    if (attempts === 2) assert.match(card.body, /Fade ran the checks:[\s\S]*real failure/);
    writeFileSync(join(cwd, 'result.txt'), String(attempts));
    return { kind: 'done', summary: 'Claimed done', howToTry: '', checks: [
      { criterion: 'it works.', passed: true, proof: `node -e "console.log('real failure');process.exit(1)"` },
    ] };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    await until(() => fade.view().reviews.length === 1);
    assert.equal(attempts, 2);
    const review = fade.view().reviews[0];
    assert.equal(review?.verdict, 'failed');
    assert.match(review?.checks?.[0]?.ran?.tail ?? '', /real failure/);
    assert.equal(review?.checks?.[0]?.ran?.sha, review?.sha);
    assert.deepEqual(JSON.parse(readFileSync(join(cwd, '.fade/state.json'), 'utf8')).retried, ['Honest']);
  } finally { fade.dispose(); }
});

test('proofs: quiet landing counts as shipped and undoDone queues the exact checkpoint', async () => {
  const cwd = makeRepo('## [ready] Version\nDone when: the version works.\n');
  const builder = new FakeBuilder(cwd);
  builder.build = async card => {
    if (card.title.startsWith('Undo:')) return { kind: 'stopped' };
    writeFileSync(join(cwd, 'version.txt'), '0.3');
    return { kind: 'done', summary: 'Version added', howToTry: '', checks: [
      { criterion: 'the version works.', passed: true, proof: `node -e "if(require('fs').readFileSync('version.txt','utf8')!=='0.3')process.exit(1)"` },
    ] };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    await until(() => fade.view().done.length === 1);
    const view = fade.view();
    assert.equal(view.reviews.length, 0);
    assert.equal(view.shippedToday, 1);
    assert.equal(view.session.quiet, 1);
    assert.equal(view.lastQuiet?.sha, view.done[0]?.sha);
    assert.match(view.toast ?? '', /verified.*u undo/);
    fade.undoDone('Version');
    assert.equal(fade.view().lastQuiet, undefined);
    assert.equal(fade.view().done.length, 0);
    assert.match(fade.view().cards[0]?.body ?? '', new RegExp(`commit ${view.done[0]?.sha}`));
    await until(() => fade.view().building === null);
  } finally { fade.dispose(); }
});

test('proofs finish before the next build, including an explicit tick while checking', async () => {
  const cwd = makeRepo('## [ready] First\nDone when: proof complete.\n\n## [ready] Second\n');
  const builder = new FakeBuilder(cwd);
  builder.build = async card => {
    if (card.title === 'Second') {
      assert.ok(existsSync(join(cwd, 'proof-complete.txt')));
      return { kind: 'unfinished', summary: 'No fade_done was called.' };
    }
    writeFileSync(join(cwd, 'first.txt'), 'first');
    return { kind: 'done', summary: 'First', howToTry: '', checks: [
      { criterion: 'proof complete.', passed: true,
        proof: `node -e "setTimeout(()=>require('fs').writeFileSync('proof-complete.txt','yes'),300)"` },
    ] };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    await until(() => fade.view().building?.action === 'checking…');
    fade.tick();
    assert.equal(fade.view().building?.title, 'First');
    await until(() => fade.view().reviews.some(review => review.title === 'Second'));
    assert.equal(fade.view().reviews.find(review => review.title === 'Second')?.verdict, 'unfinished');
  } finally { fade.dispose(); }
});

test('quick read-back writes outcome and checks, keeps request, and never replaces agreed checks', async () => {
  const cwd = makeRepo('## [ready] Quick\nAdd a version.\n\n## [ready] Agreed\nDone when: original.\n');
  const builder = new FakeBuilder(cwd);
  builder.build = async (_card, _context, emit) => {
    emit({ type: 'understood', outcome: 'Show the version.', assumptions: ['CLI only.'], doneWhen: ['version visible.'] });
    return { kind: 'unfinished', summary: 'Turn ended.' };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    await until(() => fade.view().reviews.length === 2);
    assert.match(fade.view().cards[0]?.body ?? '', /Show the version.[\s\S]*Done when: version visible.[\s\S]*Original request: Add a version/);
    assert.equal(fade.view().cards[1]?.body, 'Done when: original.');
    assert.equal(fade.view().reviews[0]?.verdict, 'unfinished');
  } finally { fade.dispose(); }
});

test('stopping proof execution never triggers an automatic retry or starts the next card', async () => {
  const cwd = makeRepo('## [ready] Slow proof\nDone when: it finishes.\n\n## [ready] Next\n');
  const builder = new FakeBuilder(cwd);
  let attempts = 0;
  builder.build = async () => {
    attempts++;
    writeFileSync(join(cwd, 'result.txt'), 'work');
    return { kind: 'done', summary: 'Ready', howToTry: '', checks: [
      { criterion: 'it finishes.', passed: true, proof: 'node -e "setInterval(()=>{},1000)"' },
    ] };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    await until(() => fade.view().building?.action === 'checking…');
    await fade.stopBuilder();
    await until(() => fade.view().building === null);
    assert.equal(attempts, 1);
    assert.equal(fade.view().reviews[0]?.verdict, 'failed');
    assert.equal(fade.view().cards[1]?.state, 'ready');
    assert.match(fade.view().reviews[0]?.checks?.[0]?.ran?.tail ?? '', /Stopped/);
  } finally { fade.dispose(); }
});
