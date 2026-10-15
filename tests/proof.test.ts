import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runProofs } from '../src/proof.js';

test('proof runner captures exit status, bounded tail and checkpoint sha; clears supplied run results', async () => {
  const results = await runProofs(process.cwd(), [
    { criterion: 'works', passed: true, proof: 'node -e "process.exit(0)"' },
    { criterion: 'fails', passed: true, proof: 'node -e "for(let i=0;i<40;i++) console.log(i); process.exit(1)"' },
    { criterion: 'said', passed: true, ran: { code: 0, tail: 'untrusted', ms: 1 } },
  ], { sha: 'a1b2c3d' });
  assert.equal(results[0]?.ran?.code, 0);
  assert.equal(results[0]?.ran?.sha, 'a1b2c3d');
  assert.equal(results[1]?.ran?.code, 1);
  assert.match(results[1]?.ran?.tail ?? '', /39/);
  assert.ok((results[1]?.ran?.tail.split('\n').length ?? 0) <= 20);
  assert.equal(results[2]?.ran, undefined);
});

test('proof timeout kills the process tree including a child that inherits its output pipes', async () => {
  const start = Date.now();
  const [result] = await runProofs(process.cwd(), [{ criterion: 'hang', passed: true,
    proof: `node -e "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});setInterval(()=>{},1000)"`,
  }], { timeoutMs: 600 });
  assert.equal(result?.ran?.code, -1);
  assert.match(result?.ran?.tail ?? '', /Timed out/);
  assert.ok(Date.now() - start < 10_000);
});

test('total cap and cancellation mark unrun proofs failed', async () => {
  const checks = [{ criterion: 'one', passed: true, proof: 'node -e "process.exit(0)"' }];
  const [capped] = await runProofs(process.cwd(), checks, { totalMs: 0 });
  assert.equal(capped?.ran?.code, -1);
  assert.match(capped?.ran?.tail ?? '', /Total proof time limit/);
  const abort = new AbortController();
  abort.abort();
  const [stopped] = await runProofs(process.cwd(), checks, { signal: abort.signal });
  assert.equal(stopped?.ran?.code, -1);
  assert.match(stopped?.ran?.tail ?? '', /Stopped/);
});
