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

test('legacy goals stay in PLAN.md without progress or goal-done announcements', async () => {
  const cwd = makeRepo('# Plan\nGoal: Legacy intent\n\n## [ready] Index titles\nDone when: titles are indexed.\n');
  const fade = makeFade(cwd);
  try {
    fade.start();
    await until(() => fade.view().reviews.length === 1);
    fade.accept('Index titles');
    assert.equal(disk(cwd).goal, 'Legacy intent');
    assert.ok(!('progress' in fade.view()));
    assert.ok(!('goalComplete' in fade.view()));
    assert.ok(!fade.view().companion.some(entry => /Goal done:/.test(entry.text)));
  } finally { fade.dispose(); }
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
  assert.equal(fade.view().cards.at(-1)?.state, 'draft');
  fade.dispose();
});

test('Fade proposes a first step without inventing a goal', async () => {
  const cwd = makeRepo('');
  const fade = makeFade(cwd);
  fade.start();
  fade.sendToCompanion('a tiny habit tracker');
  await until(() => fade.view().cards.length === 1 && !fade.view().companionBusy, 'first step');
  const view = fade.view();
  assert.equal(disk(cwd).goal, '');
  assert.equal(view.cards[0]?.state, 'draft');
  assert.ok(!view.companion.some(entry => entry.role === 'goal'));
  assert.ok(view.companion.some(entry => entry.role === 'card'));
  fade.dispose();
});
