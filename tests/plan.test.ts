import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlan, serializePlan } from '../src/plan.js';

const SAMPLE = `# Plan

## [building] Search
Search notes by title and body as you type.
Done when: typing "gro" shows "Groceries".

## [ready] Export to markdown
One .md file per note in ./export.

## [draft] Notebook styling
Warm paper, roomy margins, one column.

## Done
- Core notes app (a1b2c3d)
- Project setup
`;

test('round trip keeps a well-formed plan identical', () => {
  assert.equal(serializePlan(parsePlan(SAMPLE)), SAMPLE);
});

test('parses states, bodies and done entries', () => {
  const plan = parsePlan(SAMPLE);
  assert.deepEqual(plan.cards.map(c => c.state), ['building', 'ready', 'draft']);
  assert.equal(plan.cards[0]?.title, 'Search');
  assert.match(plan.cards[0]?.body ?? '', /^Search notes[\s\S]*Groceries/);
  assert.deepEqual(plan.done, [{ title: 'Core notes app', sha: 'a1b2c3d' }, { title: 'Project setup' }]);
});

test('hand-edited input: CRLF, missing state, odd spacing, case-insensitive Done', () => {
  const plan = parsePlan('# Mine\r\n\r\n## [Ready]   Spaced out  \r\nbody line\r\n\r\n## No state\r\n\r\n## DONE\r\n* Old thing\r\n');
  assert.equal(plan.cards[0]?.state, 'ready');
  assert.equal(plan.cards[0]?.title, 'Spaced out');
  assert.equal(plan.cards[0]?.body, 'body line');
  assert.equal(plan.cards[1]?.state, 'draft');
  assert.equal(plan.cards[1]?.title, 'No state');
  assert.deepEqual(plan.done, [{ title: 'Old thing' }]);
});

test('duplicate titles get numbered', () => {
  const plan = parsePlan('## [draft] Same\n\n## [ready] Same\n\n## [draft] Same\n');
  assert.deepEqual(plan.cards.map(c => c.title), ['Same', 'Same 2', 'Same 3']);
});

test('unknown states become draft and [done] cards move to the done list', () => {
  const plan = parsePlan('## [wat] Odd\n\n## [done] Finished\n');
  assert.equal(plan.cards.length, 1);
  assert.equal(plan.cards[0]?.state, 'draft');
  assert.deepEqual(plan.done, [{ title: 'Finished' }]);
});

test('preamble is kept, and defaults when missing', () => {
  assert.equal(parsePlan('# Notes app\n\nSome intro.\n\n## [draft] A\n').preamble, '# Notes app\n\nSome intro.\n');
  assert.equal(parsePlan('## [draft] A\n').preamble, '# Plan\n');
  assert.equal(parsePlan('').preamble, '# Plan\n');
  assert.match(serializePlan(parsePlan('# Notes app\n\n## [draft] A\n')), /^# Notes app\n\n## \[draft\] A\n/);
});

test('empty done section is omitted and output ends with a newline', () => {
  const out = serializePlan(parsePlan('## [draft] A\nbody\n'));
  assert.equal(out, '# Plan\n\n## [draft] A\nbody\n');
});
