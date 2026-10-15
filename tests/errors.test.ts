// Provider errors become one line a person can act on (found by running Fade against real providers).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { humanError } from '../src/agents/pi.js';

test('an expired OAuth login names the provider and says how to fix it', () => {
  const raw = 'OAuth refresh failed for anthropic: Anthropic token refresh request failed. url=https://x; details=Error: invalid_grant';
  assert.equal(humanError(raw), 'Your anthropic login has expired or is missing. Run fade login in another terminal, restart Fade, then try again.');
});

test('an empty account, an unreachable server and rate limits each get a plain sentence', () => {
  assert.match(humanError('402 {"error":{"message":"Insufficient account funds"}}'), /out of credits/);
  assert.match(humanError('connect ECONNREFUSED 127.0.0.1:1234'), /local model server is running/);
  assert.match(humanError('429 Too Many Requests'), /rate-limiting/);
});

test('anything else is cut to its first sentence, never a stack trace', () => {
  assert.equal(humanError('Something odd happened. More detail; details=blah stack=Error at foo (x.ts:1:1)'), 'Something odd happened.');
  assert.ok(humanError('x'.repeat(500)).length <= 200);
});
