import { test } from 'node:test';
import assert from 'node:assert/strict';

test('F25 Windows access: LongCat is selected for both roles and profiles contain no credential', async () => {
  const launcher = await import('../scripts/windows-launch.mjs');
  let calls = 0;
  const selected = await launcher.selectFreeModel('synthetic-secret', async (_url, options) => {
    calls++;
    assert.match(String(options.body), /Reply OK/);
    return Response.json({ choices: [{ message: { content: 'OK' } }] });
  });
  assert.equal(selected, 'longcat-2.5-preview-free');
  assert.equal(calls, 1);
  assert.deepEqual(launcher.freeModels, ['longcat-2.5-preview-free']);
  assert.doesNotMatch(JSON.stringify(launcher.profile(selected)), /synthetic-secret|apiKey|authorization/);
  assert.throws(() => launcher.profile('paid-model'), /free models/);
  assert.equal(launcher.readKey({ OPENCODE_API_KEY: 'synthetic-secret' }), 'synthetic-secret');
});

test('F25 Windows access: failed LongCat probe stops without substituting a model or submitting user work', async () => {
  const launcher = await import('../scripts/windows-launch.mjs');
  let calls = 0;
  await assert.rejects(launcher.selectFreeModel('synthetic', async () => {
    calls++;
    return Response.json({ error: 'unavailable' }, { status: 503 });
  }), /No user task was sent/);
  assert.equal(calls, 1);
});

