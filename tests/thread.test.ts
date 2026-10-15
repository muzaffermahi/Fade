// One thread: the goal, parked thoughts, the step the Companion just proposed, and closing a goal.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FakeBuilder, FakeCompanion } from '../src/agents/fake.js';
import { companionPlanApi } from '../src/assemble.js';
import { Git } from '../src/git.js';
import { Fade } from '../src/loop.js';
import { parsePlan, PlanStore } from '../src/plan.js';
import { StateStore } from '../src/state.js';

function makeRepo(plan: string): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fade-thread-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(cwd, 'PLAN.md'), plan);
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return cwd;
}

function makeFade(cwd: string): Fade {
  const ref: { current?: Fade } = {};
  const api = companionPlanApi(() => {
    if (!ref.current) throw new Error('not ready');
    return ref.current;
  });
  const git = new Git(cwd);
  git.excludeFade();
  ref.current = new Fade({
    cwd, plans: new PlanStore(cwd), state: new StateStore(cwd), git,
    builder: new FakeBuilder(cwd, { speed: 100000 }), companion: new FakeCompanion(api, { speed: 100000 }),
  });
  return ref.current;
}

async function until(check: () => boolean, label = 'condition'): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

const disk = (cwd: string) => parsePlan(readFileSync(join(cwd, 'PLAN.md'), 'utf8'));

test('a goal counts its shipped steps and closes when every step has shipped', async () => {
  const cwd = makeRepo('# Plan\nGoal: Search that feels instant\n\n## [ready] Index titles\nDone when: titles are indexed.\n');
  const fade = makeFade(cwd);
  fade.start();
  assert.deepEqual(fade.view().progress, { done: 0, total: 1 });
  await until(() => fade.view().reviews.length === 1, 'review');
  const review = fade.view().reviews[0];
  assert.deepEqual(review?.doneWhen, ['titles are indexed.']);
  assert.equal(review?.checks?.[0]?.passed, true, 'the Builder reported its own check');
  assert.ok(review?.tryCommand, 'and left a try command');
  assert.equal(fade.view().goalComplete, undefined);
  fade.accept('Index titles');
  assert.deepEqual(fade.view().progress, { done: 1, total: 1 });
  assert.deepEqual(fade.view().goalComplete?.steps, ['Index titles']);
  assert.deepEqual(fade.view().session.shipped, ['Index titles']);
  fade.finishGoal();
  assert.equal(fade.view().goal, '');
  assert.equal(fade.view().goalComplete, undefined);
  assert.deepEqual(fade.view().progress, { done: 0, total: 0 });
  assert.equal(disk(cwd).goal, '');
  fade.dispose();
});

test('build durations are remembered for the runway estimate', async () => {
  const cwd = makeRepo('## [ready] One\n');
  const fade = makeFade(cwd);
  fade.start();
  await until(() => fade.view().reviews.length === 1);
  const saved = JSON.parse(readFileSync(join(cwd, '.fade', 'state.json'), 'utf8'));
  assert.equal(saved.durations.length, 1);
  fade.dispose();
});

test('a new goal starts a fresh count', () => {
  const cwd = makeRepo('# Plan\nGoal: Old\n\n## [draft] A\n');
  const fade = makeFade(cwd);
  fade.setGoal('New thread');
  assert.equal(fade.view().goal, 'New thread');
  assert.equal(disk(cwd).goal, 'New thread');
  assert.deepEqual(fade.view().progress, { done: 0, total: 1 });
  fade.dispose();
});

test('parked thoughts live in Later and can come back as a step', () => {
  const cwd = makeRepo('## [draft] A\n');
  const fade = makeFade(cwd);
  fade.park('Export to markdown');
  fade.park('Export to markdown');
  assert.deepEqual(fade.view().later, ['Export to markdown'], 'no duplicates');
  assert.deepEqual(disk(cwd).later, ['Export to markdown']);
  const title = fade.promote('export to MARKDOWN', 'Markdown export', 'One file per note.\nDone when: files appear.');
  assert.equal(title, 'Markdown export');
  assert.deepEqual(fade.view().later, []);
  assert.equal(fade.view().freshDraft, 'Markdown export');
  fade.dispose();
});

test('the step the Companion proposes becomes the fresh suggestion until you ready it or move on', () => {
  const cwd = makeRepo('## [draft] Mine\n');
  const fade = makeFade(cwd);
  fade.addCard('Typed by me', '');
  assert.equal(fade.view().freshDraft, undefined, 'your own cards are not suggestions');
  fade.proposeCard('Proposed', 'body');
  assert.equal(fade.view().freshDraft, 'Proposed');
  fade.toggleReady('Proposed');
  assert.equal(fade.view().freshDraft, undefined, 'readied');
  fade.proposeCard('Another', 'body');
  fade.sendToCompanion('let us talk about something else');
  assert.equal(fade.view().freshDraft, undefined, 'moved on');
  fade.dispose();
});

test('the Companion names a goal and proposes a first step from the first message', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  fade.start();
  fade.sendToCompanion('a tiny habit tracker');
  await until(() => fade.view().cards.length === 1 && !fade.view().companionBusy, 'first step');
  const view = fade.view();
  assert.equal(view.goal, 'a tiny habit tracker');
  assert.equal(view.freshDraft, view.cards[0]?.title);
  assert.ok(view.companion.some(entry => entry.role === 'goal'));
  assert.ok(view.companion.some(entry => entry.role === 'card'));
  fade.dispose();
});
