import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBuilder, FakeCompanion } from '../src/agents/fake.js';
import { companionPlanApi } from '../src/assemble.js';
import { Git } from '../src/git.js';
import { WEB_TOOLS } from '../src/agents/pi.js';
import { COMPANION_TOOLS } from '../src/agents/companion.js';
import { formatCompanionContext } from '../src/agents/prompts.js';
import { Fade } from '../src/loop.js';
import { parsePlan, PlanStore } from '../src/plan.js';
import { StateStore } from '../src/state.js';
import { landingMessage } from '../src/view.js';
import type { Review } from '../src/types.js';

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

function makeFade(cwd: string, builder?: FakeBuilder, gitOverride?: Git): Fade {
  const plans = new PlanStore(cwd);
  const state = new StateStore(cwd);
  const git = gitOverride ?? new Git(cwd);
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

test('ready starts the requested proposal', async () => {
  const cwd = makeRepo('## [draft] One\n\n## [draft] Two\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.ready('Two');
  assert.deepEqual(states(fade), ['draft:One', 'building:Two']);
  await fade.stopBuilder();
  await until(() => fade.view().building === null);
  fade.ready('One');
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
  assert.equal(view.companion.at(-1)?.text, '✓ Alpha — done.');
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
  assert.match(fade.view().cards[0]?.body ?? '', /^make it blue$/);
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
  await until(() => fade.view().done.some(r => r.title === 'Undo: Alpha'), 'undo landing');
  assert.ok(!fade.view().cards.some(c => c.title === 'Alpha'));
  fade.dispose();
});

test('fade_queue starts at the end; fade_note_builder forwards a note', async () => {
  const cwd = makeRepo('## [draft] Existing\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  fade.start();
  fade.queue('Footer', 'Add a footer with a contact link');
  const view = fade.view();
  assert.equal(view.building?.title, 'Footer');
  assert.match(view.cards[1]?.body ?? '', /contact link$/);
  fade.noteBuilder('use blue');
  assert.match(fade.view().companion.at(-1)?.text ?? '', /passed that along/);
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
  assert.deepEqual(roles.slice(0, 2), ['you', 'landed']);
  assert.match(fade.view().companion.at(-1)?.text ?? '', /Want it/);
  assert.ok(JSON.parse(readFileSync(join(cwd, '.fade', 'state.json'), 'utf8')).companion.length >= 2);
  fade.dispose();
});

test('the Companion only gets read-only built-in tools plus the card tools', () => {
  for (const banned of ['edit', 'write', 'bash']) assert.ok(!COMPANION_TOOLS.includes(banned), banned);
  assert.deepEqual(COMPANION_TOOLS.filter(name => !name.startsWith('fade_') && !WEB_TOOLS.includes(name)), ['read', 'grep', 'find', 'ls']);
  for (const tool of ['queue', 'ready', 'note_builder', 'stop_builder', 'accept', 'revise', 'undo', 'show', 'move']) {
    assert.ok(COMPANION_TOOLS.includes(`fade_${tool}`));
  }
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
  await until(() => first.view().companion.some(e => e.role === 'landed'), 'reply');
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
    assert.ok(view.companion.some(entry => /✓ Version.*checked/.test(entry.text)));
    fade.undoDone('Version');
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


test('v0.4 yes readies the only proposal; two proposals send yes to Fade', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  try {
    fade.proposeCard('Only', 'One thing.');
    fade.sendToCompanion('yes');
    assert.equal(fade.view().building?.title, 'Only');
    assert.match(fade.view().companion.at(-1)?.text ?? '', /^On it: Only\. The Builder is on it now/);
    fade.proposeCard('A', 'a'); fade.proposeCard('B', 'b');
    fade.sendToCompanion('yes');
    await until(() => !fade.view().companionBusy);
    assert.match(fade.view().companion.at(-1)?.text ?? '', /Want it/);
    assert.equal(fade.view().cards.find(c => c.title === 'A')?.state, 'draft');
  } finally { fade.dispose(); }
});

test('v0.4 stop stops only the current build and does not start the next', async () => {
  const cwd = makeRepo('## [ready] First\n\n## [ready] Second\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, { speed: 1 }));
  try {
    fade.start(); fade.sendToCompanion('stop');
    await until(() => fade.view().building === null);
    assert.equal(fade.view().cards.find(c => c.title === 'Second')?.state, 'ready');
    assert.match(fade.view().companion.at(-1)?.text ?? '', /■ Stopped First/);
  } finally { fade.dispose(); }
});

test('v0.4 startOver replaces body and carries the exact review checkpoint', async () => {
  const cwd = makeRepo('## [ready] Original\nOld scope.\n');
  const fade = makeFade(cwd);
  try {
    fade.start(); await until(() => fade.view().reviews.length === 1);
    const sha = fade.view().reviews[0]?.sha;
    await fade.revise('Original', 'New scope.', true);
    assert.equal(fade.view().cards[0]?.body, `New scope.\n\nStart from: revert ${sha} first`);
    assert.doesNotMatch(fade.view().cards[0]?.body ?? '', /Old scope|Revise:/);
  } finally { fade.dispose(); }
});

test('v0.4 mid-build startOver waits for the partial checkpoint before restarting', async () => {
  const cwd = makeRepo('## [ready] Original\nOld scope.\n');
  const builder = new FakeBuilder(cwd, { speed: 1 });
  const fade = makeFade(cwd, builder);
  try {
    fade.start();
    writeFileSync(join(cwd, 'partial.txt'), 'wrong start');
    await fade.revise('Original', 'Correct scope.', true);
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
    assert.equal(fade.view().cards[0]?.body, `Correct scope.\n\nStart from: revert ${sha} first`);
    assert.equal(fade.view().building?.title, 'Original');
  } finally { fade.dispose(); }
});

test('v0.4 verified outcome landing persists without goal completion; undo words target the checkpoint', async () => {
  const cwd = makeRepo('# Plan\nGoal: Tiny CLI\n\n## [ready] Version\nDone when: visible.\n\n## Later\n- Export\n');
  const builder = new FakeBuilder(cwd);
  builder.build = async () => {
    writeFileSync(join(cwd, 'version.txt'), '1.0.0');
    return { kind: 'done', summary: 'Added version.', howToTry: '', checks: [{ criterion: 'visible.', passed: true, proof: 'node -e "process.exit(0)"' }] };
  };
  const fade = makeFade(cwd, builder);
  try {
    fade.start(); await until(() => fade.view().done.length === 1);
    const view = fade.view();
    assert.ok(view.companion.some(e => e.role === 'landed' && /✓ Version.*visible.*checked/.test(e.text)));
    assert.ok(!view.companion.some(e => /Goal done:/.test(e.text)));
    assert.ok(!view.companion.some(e => e.role === 'landed' && /node -e/.test(e.text)));
    assert.equal(view.landedReviews[0]?.checks?.[0]?.ran?.code, 0);
    const restored = makeFade(cwd);
    try { assert.equal(restored.view().landedReviews[0]?.checks?.[0]?.ran?.code, 0); }
    finally { restored.dispose(); }
    const sha = view.done[0]?.sha;
    fade.sendToCompanion('undo');
    assert.match(fade.view().cards[0]?.body ?? '', new RegExp(`commit ${sha}`));
  } finally { fade.dispose(); }
});

test('v0.4 yes answers a single look, but a simultaneous draft makes it ambiguous', async () => {
  const cwd = makeRepo('## [ready] Style\nDone when: calmer.\n');
  const builder = new FakeBuilder(cwd);
  builder.build = async () => ({ kind: 'done', summary: 'Style.', howToTry: '', checks: [{ criterion: 'calmer.', passed: true, look: 'Does it feel calmer?' }] });
  const fade = makeFade(cwd, builder);
  try {
    fade.start(); await until(() => fade.view().reviews.length === 1);
    assert.match(formatCompanionContext(fade.view()), /NEEDS YOU:[\s\S]*Does it feel calmer/);
    fade.proposeCard('Another', 'another');
    fade.sendToCompanion('yes'); await until(() => !fade.view().companionBusy);
    assert.equal(fade.view().reviews.length, 1);
    for (const card of fade.view().cards.filter(c => c.state === 'draft')) fade.model.remove(card.title);
    fade.sendToCompanion('yes');
    assert.equal(fade.view().reviews.length, 0);
    assert.equal(fade.view().done.at(-1)?.title, 'Style');
  } finally { fade.dispose(); }
});

test('v0.4 landing copy covers every verdict without a model call', () => {
  const base: Review = { title: 'Export', verdict: 'said', summary: '', howToTry: 'open ./export', files: [], finishedAt: 0,
    checks: [{ criterion: 'files open in Obsidian.', passed: true }] };
  assert.match(landingMessage(base), /not checked: files open in Obsidian\. Say/);
  assert.match(landingMessage({ ...base, verdict: 'look', checks: [{ criterion: 'calm', passed: true, look: 'Calmer?' }] }), /Your call: Calmer/);
  assert.match(landingMessage({ ...base, verdict: 'failed' }, true), /Sent it back once/);
  assert.match(landingMessage({ ...base, verdict: 'unfinished' }), /not checked.*Say "continue"/);
  assert.match(landingMessage({ ...base, verdict: 'none' }), /not checked/);
});

test('v0.4 a correction can restart a quietly landed card from its exact checkpoint', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  try {
    fade.queue('Small', 'Demo.\nDone when: the requested demo file exists.');
    await until(() => fade.view().done.length === 1);
    const sha = fade.view().done[0]?.sha;
    await fade.revise('Small', 'Corrected scope.', true);
    assert.equal(fade.view().cards[0]?.body, `Corrected scope.\n\nStart from: revert ${sha} first`);
    assert.equal(fade.view().done.length, 0);
  } finally { fade.dispose(); }
});

test('v0.4 undo targets the most recent review before an older quiet landing', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  try {
    fade.queue('Old', 'Demo.\nDone when: the requested demo file exists.');
    await until(() => fade.view().done.length === 1);
    fade.queue('New', 'Demo.\nDone when: calmer.');
    await until(() => fade.view().reviews.length === 1);
    fade.sendToCompanion('undo');
    assert.equal(fade.view().cards[0]?.title, 'Undo: New');
    assert.equal(fade.view().done[0]?.title, 'Old');
  } finally { fade.dispose(); }
});

test('v0.4 demo undo really restores the prior artifact', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  try {
    fade.queue('Demo', 'Demo.\nDone when: the requested demo file exists.');
    await until(() => fade.view().done.length === 1);
    assert.ok(existsSync(join(cwd, 'fade-demo/demo.txt')));
    fade.sendToCompanion('undo that');
    await until(() => fade.view().done.some(d => d.title === 'Undo: Demo'));
    assert.equal(existsSync(join(cwd, 'fade-demo/demo.txt')), false);
  } finally { fade.dispose(); }
});

test('v0.4 a failed checkpoint stays in needs-you and explains the failure', async () => {
  const cwd = makeRepo('## [ready] Demo\nDone when: the requested demo file exists.\n');
  const git = new Git(cwd);
  git.checkpoint = () => ({ error: 'invalid path: nul' });
  const fade = makeFade(cwd, undefined, git);
  try {
    fade.start(); await until(() => fade.view().reviews.length === 1);
    assert.equal(fade.view().done.length, 0);
    assert.equal(fade.view().reviews[0]?.verdict, 'verified');
    assert.match(fade.view().companion.at(-1)?.text ?? '', /○ Demo.*not checked.*no checkpoint.*invalid path: nul/);
  } finally { fade.dispose(); }
});

test('polish: checked outcomes never print the raw proof command', () => {
  const review: Review = {
    title: 'Search works', verdict: 'verified', summary: 'Search is available.', howToTry: '',
    files: [], finishedAt: 0, sha: 'abc', checks: [{
      criterion: "typing 'gro' finds Groceries", passed: true,
      proof: 'node -e "require(123)"', ran: { code: 0, tail: '', ms: 1 },
    }],
  };
  assert.equal(landingMessage(review), "✓ Search works — typing 'gro' finds Groceries · checked");
  assert.doesNotMatch(landingMessage({ ...review, checks: [{
    criterion: 'node cli.js --version prints the right version', passed: true,
    proof: 'node cli.js --version', ran: { code: 0, tail: '', ms: 1 },
  }] }), /node|cli.js|--version/);
});

test('final pass: normalized queue replies come from Fade and replace model acknowledgements', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  try {
    fade.sendToCompanion('add a dark mode toggle');
    await until(() => !fade.view().companionBusy && fade.view().done.length === 1);
    const replies = fade.view().companion.filter(entry => /^On it:/i.test(entry.text));
    assert.equal(replies.length, 1);
    assert.match(replies[0]?.text ?? '', /^On it: Dark mode toggle\. The Builder is on it now/);
    assert.equal(fade.view().done[0]?.title, 'Dark mode toggle');
    fade.sendToCompanion('undo that');
    assert.equal(fade.view().companion.at(-1)?.text, '↶ Undoing Dark mode toggle…');
    await until(() => !fade.view().building);
    assert.equal(fade.view().companion.at(-1)?.text, '↶ Dark mode toggle is undone.');
  } finally { fade.dispose(); }
});

test('final pass: dirty launch warns and the current-branch commit notice is said once', () => {
  const cwd = makeRepo('');
  writeFileSync(join(cwd, 'README.md'), 'my uncommitted work');
  const first = makeFade(cwd);
  first.welcome();
  assert.match(first.view().companion[0]?.text ?? '', /uncommitted changes/);
  assert.match(first.view().companion[1]?.text ?? '', /commit each change on .*fade: …/);
  first.dispose();
  const second = makeFade(cwd);
  try {
    second.welcome();
    assert.equal(second.view().companion.filter(e => /commit each change on/.test(e.text)).length, 1);
    assert.equal(readFileSync(join(cwd, 'README.md'), 'utf8'), 'my uncommitted work');
  } finally { second.dispose(); }
});

test('final pass: continue resumes one paused request without a model turn', async () => {
  const cwd = makeRepo('## [draft] Paused\nA saved request.\n');
  const fade = makeFade(cwd, new FakeBuilder(cwd, {speed: 1}));
  try {
    fade.sendToCompanion('continue');
    assert.equal(fade.view().building?.title, 'Paused');
    assert.equal(fade.view().companionBusy, false);
    assert.match(fade.view().companion.at(-1)?.text ?? '', /^On it: Paused\./);
    await fade.stopBuilder();
  } finally {fade.dispose();}
});

test('final pass: continue retries a failed result; it never accepts the failed claim', async () => {
  const cwd = makeRepo('## [ready] Retry\nDone when: result works.\n');
  const builder = new FakeBuilder(cwd);
  let attempts = 0;
  builder.build = async () => {
    attempts++;
    writeFileSync(join(cwd, 'result.txt'), String(attempts));
    return {kind:'done',summary:'Result.',howToTry:'',checks:[{
      criterion:'result works.',passed:attempts>1,proof:`node -e "process.exit(${attempts>1?0:1})"`,
    }]};
  };
  const fade = makeFade(cwd,builder);
  try {
    fade.start();await until(()=>fade.view().reviews.length===1);
    fade.sendToCompanion('continue');
    assert.equal(fade.view().companionBusy,false);
    assert.equal(fade.view().done.length,0);
    await until(()=>fade.view().done.length===1);
    assert.equal(attempts,2);
    assert.equal(fade.view().landedReviews[0]?.checks?.[0]?.ran?.code,0);
  } finally {fade.dispose();}
});
