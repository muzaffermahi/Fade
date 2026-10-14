import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { Type } from 'typebox';
import { validate } from '../src/contracts.js';

test('G36/G56 F25: recovery rejects unrelated rehearsal identity before loading product or locking workspace', () => {
  const f = fixture(); copyFileSync('scripts/qualification-recover.mjs', join(f.root, 'scripts/qualification-recover.mjs'));
  const archive = join(f.root, 'candidate.tgz'); writeFileSync(archive, 'synthetic hash fixture');
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(join(f.root, 'releases', 'candidate.json'), JSON.stringify({ archive, sha256 }));
  const workspace = join(f.root, 'workspace'), packageRoot = join(f.root, 'not-installed');
  mkdirSync(workspace); mkdirSync(join(workspace, '.fade')); writeFileSync(join(workspace, '.fade', 'state.json'), 'preserve this state');
  writeFileSync(join(workspace, 'evaluation.json'), JSON.stringify({ candidateSha256: '0'.repeat(64), packageRoot, passed: false }));
  const result = spawnSync(process.execPath, [join(f.root, 'scripts', 'qualification-recover.mjs')], {
    env: { ...process.env, FADE_CANDIDATE_SHA256: sha256, FADE_PACKAGE_ROOT: packageRoot, FADE_RECOVERY_WORKSPACE: workspace }, encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.status, 1); assert.match(result.stderr, /Require a failed rehearsal against this installed artifact/);
  assert.equal(existsSync(join(workspace, '.fade', 'lock')), false);
  assert.equal(readFileSync(join(workspace, '.fade', 'state.json'), 'utf8'), 'preserve this state');
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'fade-qualification-guard-')); mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'releases'));
  copyFileSync('scripts/qualification-artifact.mjs', join(root, 'scripts', 'qualification-artifact.mjs'));
  const original = '{"historical":"preserve these exact bytes"}\n'; writeFileSync(join(root, 'releases', 'candidate.json'), original);
  return { root, original };
}
function run(root: string, env: Record<string, string>) {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'qualification-artifact.mjs')], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
  return validate(Type.Object({ passed: Type.Boolean(), failure: Type.String() }), JSON.parse(readFileSync(join(root, 'output', 'artifact-qualification.json'), 'utf8')));
}
test('G52/G57 F25: mismatched archive SHA rejects before install and preserves the candidate record', () => {
  const f = fixture(), path = join(f.root, 'candidate.tgz'); writeFileSync(path, 'invalid archive');
  const result = run(f.root, { FADE_CANDIDATE_ARCHIVE: path, FADE_CANDIDATE_SHA256: '0'.repeat(64) });
  assert.equal(result.passed, false); assert.match(result.failure, /checksum mismatch/); assert.equal(readFileSync(join(f.root, 'releases', 'candidate.json'), 'utf8'), f.original);
});
test('G36/G57 F25: even a checksum-matching traversal archive rejects before extraction', () => {
  const f = fixture(), path = join(f.root, 'candidate.tgz'), header = Buffer.alloc(512);
  header.write('package/../../escaped.txt'); header.write('00000000001\0', 124); header[156] = 48;
  const bytes = gzipSync(Buffer.concat([header, Buffer.from('x'), Buffer.alloc(511 + 1024)])); writeFileSync(path, bytes);
  const result = run(f.root, { FADE_CANDIDATE_ARCHIVE: path, FADE_CANDIDATE_SHA256: createHash('sha256').update(bytes).digest('hex') });
  assert.match(result.failure, /unsafe/); assert.equal(existsSync(join(f.root, 'escaped.txt')), false); assert.equal(readFileSync(join(f.root, 'releases', 'candidate.json'), 'utf8'), f.original);
});
test('G57 F25: archive URL credentials reject locally without leaking secret values to evidence', () => {
  const f = fixture(); const result = run(f.root, { FADE_CANDIDATE_ARCHIVE: '', FADE_CANDIDATE_SHA256: '0'.repeat(64), FADE_CANDIDATE_URL: 'https://user:SECRET-CANARY@example.invalid/archive.tgz' });
  assert.match(result.failure, /credential-free HTTPS/); assert.doesNotMatch(JSON.stringify(result), /SECRET-CANARY/); assert.equal(readFileSync(join(f.root, 'releases', 'candidate.json'), 'utf8'), f.original);
});
