import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
const root = dirname(dirname(fileURLToPath(import.meta.url))), destination = join(root, 'releases'); mkdirSync(destination, { recursive: true });
const result = { candidateSha256: process.env.FADE_CANDIDATE_SHA256, previousSha256: process.env.FADE_PREVIOUS_SHA256, node: process.version, platform: process.platform,
  passed: false, scope: 'Exact-archive isolated install/upgrade/aliases/diagnostics/uninstall; no physical/provider/participant claim' };
const record = join(root, 'output', 'artifact-qualification.json'); mkdirSync(dirname(record), { recursive: true });
const existing = join(destination, 'candidate.json'), original = existsSync(existing) ? readFileSync(existing) : undefined;
async function artifact(kind) {
  const hash = process.env[`FADE_${kind}_SHA256`]; if (!/^[a-f0-9]{64}$/.test(hash ?? '')) throw new Error(`Missing/invalid ${kind} SHA256`);
  const supplied = process.env[`FADE_${kind}_ARCHIVE`]; let bytes;
  if (supplied) bytes = readFileSync(resolve(supplied));
  else {
    const url = new URL(process.env[`FADE_${kind}_URL`] ?? '');
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Use a credential-free HTTPS ${kind} archive URL`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!response.ok) throw new Error(`${kind} archive HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error(`${kind} archive size/checksum mismatch`);
  const tar = gunzipSync(bytes, { maxOutputLength: 64 * 1024 * 1024 }); let entries = 0;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').split('\0')[0], prefix = header.subarray(345, 500).toString('utf8').split('\0')[0];
    const path = prefix ? prefix + '/' + name : name, type = header[156], size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8);
    if (++entries > 2048 || !path || !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..') || ![0, 48, 53].includes(type)
      || !Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error(`${kind} archive has an unsafe/unsupported entry`);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  const directory = mkdtempSync(join(tmpdir(), 'fade-qualified-archive-')), archive = join(directory, 'candidate.tgz'); writeFileSync(archive, bytes);
  execFileSync('tar', ['-xf', archive, '-C', directory]); const manifest = JSON.parse(readFileSync(join(directory, 'package', 'package.json'), 'utf8'));
  if (!['fade', '@muzaffermahi/fade'].includes(manifest.name) || !/^1\.0\.0(?:-rc\.\d+)?$/.test(manifest.version)) throw new Error(`${kind} archive identity is not a known Fade candidate`);
  return { archive, sha256: hash, name: manifest.name, version: manifest.version };
}
try {
  const candidate = await artifact('CANDIDATE'), previous = await artifact('PREVIOUS');
  if (candidate.name !== '@muzaffermahi/fade' || previous.version === candidate.version) throw new Error('Require scoped candidate and a distinct actual previous version');
  writeFileSync(existing, JSON.stringify({ ...candidate, previous }, null, 2));
  const output = execFileSync(process.execPath, ['scripts/package-smoke.mjs'], { cwd: root, encoding: 'utf8', maxBuffer: 10000000 });
  const start = output.lastIndexOf('\n{'); if (start < 0) throw new Error('Missing smoke evidence');
  result.smoke = JSON.parse(output.slice(start + 1)); result.passed = true;
} catch (error) { result.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally {
  if (original) writeFileSync(existing, original);
  writeFileSync(record, JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
}
