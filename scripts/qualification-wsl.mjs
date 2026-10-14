import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
if (process.platform !== 'win32') throw new Error('This driver requires Windows with the existing Ubuntu-24.04 WSL distribution');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const candidate = JSON.parse(readFileSync(join(root, 'releases/candidate.json'), 'utf8'));
for (const artifact of [candidate, candidate.previous]) {
  if (!artifact || !/^[a-f0-9]{64}$/.test(artifact.sha256) || createHash('sha256').update(readFileSync(artifact.archive)).digest('hex') !== artifact.sha256) throw new Error('Current/prior artifact checksum mismatch');
}
const stage = mkdtempSync(join(root, 'output/wsl-qualification-'));
for (const directory of ['scripts', 'releases', 'output']) mkdirSync(join(stage, directory));
for (const name of ['qualification-artifact.mjs', 'package-smoke.mjs', 'npm-cli.mjs']) copyFileSync(join(root, 'scripts', name), join(stage, 'scripts', name));
copyFileSync(candidate.archive, join(stage, 'releases/candidate.tgz'));
copyFileSync(candidate.previous.archive, join(stage, 'releases/previous.tgz'));
const versions = ['22.23.3', '24.14.1'], runtimes = [];
for (const version of versions) {
  const name = `node-v${version}-linux-x64.tar.xz`, base = `https://nodejs.org/dist/v${version}/`;
  const responses = await Promise.all([fetch(base + 'SHASUMS256.txt', { signal: AbortSignal.timeout(120000) }), fetch(base + name, { signal: AbortSignal.timeout(120000) })]);
  if (responses.some(response => !response.ok)) throw new Error(`Official Node ${version} download failed`);
  const sums = await responses[0].text(), bytes = Buffer.from(await responses[1].arrayBuffer());
  const expected = sums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(fields => fields[1] === name)?.[0];
  if (!expected || !/^[a-f0-9]{64}$/.test(expected) || bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error(`Official Node ${version} checksum mismatch`);
  writeFileSync(join(stage, name), bytes); runtimes.push({ version, url: base + name, sha256: expected });
}
const linuxStage = execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--exec', 'wslpath', '-u', stage], { encoding: 'utf8', timeout: 30000 }).trim();
const script = `set -eu
stage=$1
candidate_sha=$2
previous_sha=$3
version=$4
qualification_root=$(mktemp -d /tmp/fade-wsl-qualification-XXXXXX)
printf '%s\\n' "$qualification_root" > "$stage/output/workspace-$version.txt"
mkdir -p "$qualification_root/scripts" "$qualification_root/releases" "$qualification_root/runtimes"
cp "$stage"/scripts/*.mjs "$qualification_root/scripts/"
cp "$stage/releases/candidate.tgz" "$stage/releases/previous.tgz" "$qualification_root/releases/"
tar -xJf "$stage/node-v$version-linux-x64.tar.xz" -C "$qualification_root/runtimes"
export PATH="$qualification_root/runtimes/node-v$version-linux-x64/bin:$PATH"
export FADE_NPM_CLI="$qualification_root/runtimes/node-v$version-linux-x64/lib/node_modules/npm/bin/npm-cli.js"
export FADE_CANDIDATE_ARCHIVE="$qualification_root/releases/candidate.tgz"
export FADE_PREVIOUS_ARCHIVE="$qualification_root/releases/previous.tgz"
export FADE_CANDIDATE_SHA256="$candidate_sha" FADE_PREVIOUS_SHA256="$previous_sha"
export NPM_CONFIG_CACHE="$qualification_root/npm-cache" NPM_CONFIG_USERCONFIG="$qualification_root/empty.npmrc" NPM_CONFIG_GLOBALCONFIG="$qualification_root/empty-global.npmrc"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org NPM_CONFIG_FETCH_RETRIES=1 NPM_CONFIG_FETCH_TIMEOUT=120000
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
cd "$qualification_root"
status=0
node scripts/qualification-artifact.mjs || status=$?
cp output/artifact-qualification.json "$stage/output/node-$version.json"
exit "$status"
`;
const results = [];
for (const version of versions) {
  let failure;
  try {
    const output = execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--exec', 'timeout', '--kill-after=30s', '720s', 'sh', '-s', '--', linuxStage, candidate.sha256, candidate.previous.sha256, version], { input: script, encoding: 'utf8', timeout: 800000, maxBuffer: 20000000 });
    writeFileSync(join(stage, 'output', `node-${version}.log`), output);
  } catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const evidence = join(stage, 'output', `node-${version}.json`);
  const result = existsSync(evidence) ? JSON.parse(readFileSync(evidence, 'utf8')) : undefined;
  if (result && (result.node !== `v${version}` || result.platform !== 'linux' || result.candidateSha256 !== candidate.sha256 || result.previousSha256 !== candidate.previous.sha256)) throw new Error('Linux runtime/artifact evidence identity mismatch');
  results.push({ version, failure, ...(result ? { result, evidence } : { passed: false, scope: 'No terminal artifact evidence' }) });
  console.log(`WSL Node ${version}: ${results.at(-1).result?.passed === true ? 'PASS' : 'FAIL'} · ${stage}`);
}
const record = { candidateSha256: candidate.sha256, previousSha256: candidate.previous.sha256, distribution: 'Ubuntu-24.04', virtualization: 'WSL2', stage, runtimes, results,
  passed: results.every(result => result.result?.passed === true), scope: 'Actual Linux userland exact-archive install/upgrade/aliases/diagnostics/uninstall; not native Linux desktop, CI, physical terminal, provider or participant qualification' };
writeFileSync(join(root, 'output/readiness-F25-wsl-artifact.json'), JSON.stringify(record, null, 2));
console.log(JSON.stringify(record, null, 2)); if (!record.passed) process.exitCode = 1;
