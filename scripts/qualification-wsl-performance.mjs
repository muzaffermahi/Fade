import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const root = dirname(dirname(fileURLToPath(import.meta.url))), candidate = JSON.parse(readFileSync(join(root, 'releases/candidate.json'), 'utf8'));
const wsl = JSON.parse(readFileSync(join(root, 'output/readiness-F25-wsl-artifact.json'), 'utf8'));
if (!wsl.passed || wsl.candidateSha256 !== candidate.sha256 || createHash('sha256').update(readFileSync(candidate.archive)).digest('hex') !== candidate.sha256) throw new Error('Require verified current WSL artifact rehearsal');
const version = '24.14.1', linuxRoot = readFileSync(join(wsl.stage, 'output', `workspace-${version}.txt`), 'utf8').trim();
if (!/^\/tmp\/fade-wsl-qualification-[a-zA-Z0-9]+$/.test(linuxRoot)) throw new Error('Unexpected isolated Linux rehearsal root');
const runtime = wsl.runtimes.find(runtime => runtime.version === version);
if (!runtime || createHash('sha256').update(readFileSync(join(wsl.stage, `node-v${version}-linux-x64.tar.xz`))).digest('hex') !== runtime.sha256) throw new Error('Portable Linux runtime archive changed');
if (createHash('sha256').update(readFileSync(join(wsl.stage, 'releases/candidate.tgz'))).digest('hex') !== candidate.sha256) throw new Error('Staged candidate archive changed');
const priorRecord = join(root, 'output/readiness-F25-wsl-performance.json'), setupFailure = join(root, 'output/readiness-F25-wsl-performance-setup-failure.json');
if (existsSync(priorRecord) && !existsSync(setupFailure)) copyFileSync(priorRecord, setupFailure);
const firstPass = join(root, 'output/readiness-F25-wsl-performance-first-pass.json');
if (existsSync(priorRecord) && JSON.parse(readFileSync(priorRecord, 'utf8')).passed && !existsSync(firstPass)) copyFileSync(priorRecord, firstPass);
const compiled = ts.transpileModule(readFileSync(join(root, 'scripts/performance.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText.replace(/from (['"])\.\.\/src\/([^'"]+)\1/g, "from './dist/$2'");
writeFileSync(join(wsl.stage, 'output/_qualification-performance.mjs'), compiled);
const linuxStage = execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--exec', 'wslpath', '-u', wsl.stage], { encoding: 'utf8', timeout: 30000 }).trim();
const script = `set -eu
stage=$1
qualification_root=$(mktemp -d /tmp/fade-wsl-performance-XXXXXX)
printf '%s\\n' "$qualification_root" > "$stage/output/performance-workspace.txt"
mkdir -p "$qualification_root/runtimes" "$qualification_root/releases"
tar -xJf "$stage/node-v24.14.1-linux-x64.tar.xz" -C "$qualification_root/runtimes"
cp "$stage/releases/candidate.tgz" "$qualification_root/releases/candidate.tgz"
export PATH="$qualification_root/runtimes/node-v24.14.1-linux-x64/bin:$PATH"
export NPM_CONFIG_CACHE="$qualification_root/npm-cache" NPM_CONFIG_USERCONFIG="$qualification_root/empty.npmrc" NPM_CONFIG_GLOBALCONFIG="$qualification_root/empty-global.npmrc"
export NPM_CONFIG_REGISTRY=https://registry.npmjs.org NPM_CONFIG_FETCH_RETRIES=1 NPM_CONFIG_FETCH_TIMEOUT=120000
: > "$NPM_CONFIG_USERCONFIG"
: > "$NPM_CONFIG_GLOBALCONFIG"
export PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1
node "$qualification_root/runtimes/node-v24.14.1-linux-x64/lib/node_modules/npm/bin/npm-cli.js" install --prefix "$qualification_root/performance-install" --omit=dev --ignore-scripts --no-audit --no-fund "$qualification_root/releases/candidate.tgz"
package_root="$qualification_root/performance-install/node_modules/@muzaffermahi/fade"
cp "$stage/output/_qualification-performance.mjs" "$package_root/_qualification-performance.mjs"
cd "$package_root"
status=0
node _qualification-performance.mjs > "$stage/output/performance-linux-raw.log" || status=$?
cat "$stage/output/performance-linux-raw.log"
evidence=$(node --input-type=module -e 'import {readFileSync} from "node:fs";const text=readFileSync(process.argv[1],"utf8");const start=text.lastIndexOf("\\n{");if(start>=0)console.log(JSON.parse(text.slice(start+1)).evidence);' "$stage/output/performance-linux-raw.log")
case "$evidence" in
  /tmp/fade-performance-*) mkdir -p "$stage/output/linux-captures"; cp "$evidence"/*.txt "$evidence"/*.ansi "$evidence/metrics.json" "$stage/output/linux-captures/" ;;
esac
exit "$status"
`;
const record = { candidateSha256: candidate.sha256, priorRehearsalRoot: linuxRoot, distribution: 'Ubuntu-24.04', virtualization: 'WSL2', passed: false, scope: 'Actually installed archive split UI with unchanged synthetic long-session benchmark; no physical terminal/provider latency claim' };
try {
  const output = execFileSync('wsl', ['-d', 'Ubuntu-24.04', '--exec', 'timeout', '--kill-after=30s', '720s', 'sh', '-s', '--', linuxStage], { input: script, encoding: 'utf8', timeout: 800000, maxBuffer: 20000000 });
  writeFileSync(join(root, 'output/readiness-F25-wsl-performance-raw.log'), output);
  const start = output.lastIndexOf('\n{'); if (start < 0) throw new Error('Benchmark evidence missing');
  record.measurements = JSON.parse(output.slice(start + 1));
  record.linuxRoot = readFileSync(join(wsl.stage, 'output/performance-workspace.txt'), 'utf8').trim();
  record.captures = join(wsl.stage, 'output/linux-captures');
  if (record.measurements.hardware?.platform !== 'linux' || record.measurements.hardware?.node !== 'v24.14.1') throw new Error('Wrong performance runtime/platform');
  record.passed = true;
} catch (error) { record.failure = error instanceof Error ? error.message : String(error); process.exitCode = 1; }
finally { writeFileSync(join(root, 'output/readiness-F25-wsl-performance.json'), JSON.stringify(record, null, 2)); console.log(JSON.stringify(record, null, 2)); }
