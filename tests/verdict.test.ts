import assert from 'node:assert/strict';
import { test } from 'node:test';
import { matchChecks, verdict } from '../src/verdict.js';
import type { Check } from '../src/types.js';

const claim: Check = { criterion: 'Tests pass.', passed: true };
test('only a successful Fade proof verifies; every done-table row stays honest', () => {
  const lines = ['Tests pass.'];
  assert.equal(verdict(lines, [{ ...claim, proof: 'test', ran: { code: 0, tail: '', ms: 1 } }]), 'verified');
  for (const code of [1, -1]) {
    assert.equal(verdict(lines, [{ ...claim, proof: 'test', ran: { code, tail: 'failure', ms: 1 } }]), 'failed');
  }
  assert.equal(verdict(lines, [claim]), 'said');
  assert.equal(verdict(lines, [{ ...claim, proof: 'test' }]), 'said');
  assert.equal(verdict(lines, [{ ...claim, look: 'Does this feel right?' }]), 'look');
  assert.equal(verdict(lines, []), 'failed');
  assert.equal(verdict([], [claim]), 'none');
  assert.equal(verdict([], []), 'none');
  assert.equal(verdict(['Tests pass.', 'Looks calmer'], [
    { ...claim, proof: 'test', ran: { code: 0, tail: '', ms: 1 } },
    { criterion: 'Looks calmer', passed: false, look: 'Is it calmer?' },
  ]), 'look');
});

test('matching normalizes text, supports equal-count index fallback, and exposes omitted lines', () => {
  assert.equal(matchChecks(['TESTS pass!'], [claim])[0]?.passed, true);
  assert.equal(matchChecks(['a rephrasing'], [claim])[0]?.passed, true);
  const matched = matchChecks(['missing', 'Tests pass.'], [claim]);
  assert.equal(matched[0]?.evidence, 'not addressed');
  assert.equal(matched[1]?.passed, true);
  assert.equal(matchChecks(['Tests pass.'], [claim, claim]).length, 1);
});
