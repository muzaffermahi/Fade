import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { npmCli } from './npm-cli.mjs';
import ts from 'typescript';
import { createRequire } from 'node:module';
const root = dirname(dirname(fileURLToPath(import.meta.url))), candidate = JSON.parse(readFileSync(join(root, 'releases/candidate.json'), 'utf8'));
if (candidate.name !== '@muzaffermahi/fade' || !/^[a-f0-9]{64}$/.test(candidate.sha256) || createHash('sha256').update(readFileSync(candidate.archive)).digest('hex') !== candidate.sha256) throw new Error('Candidate identity/checksum mismatch');
const record = join(root, 'output/installed-qualification.json'); mkdirSync(dirname(record), { recursive: true });
let installed;
if (existsSync(record)) { const prior = JSON.parse(readFileSync(record, 'utf8')); if (prior.candidateSha256 === candidate.sha256 && existsSync(join(prior.packageRoot, 'dist/cli.js'))) installed = prior; }
if (!installed) {
  const environment = mkdtempSync(join(tmpdir(), 'fade-installed-qualification-')), prefix = join(environment, 'install');
  execFileSync(process.execPath, [npmCli(), 'install', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', candidate.archive], { stdio: 'inherit' });
  const packageRoot = join(prefix, 'node_modules', candidate.name), manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== candidate.name || manifest.version !== candidate.version) throw new Error('Installed candidate mismatch');
  const versions = {};
  const require = createRequire(join(packageRoot, 'package.json'));
  for (const name of ['pi-ai', 'pi-coding-agent', 'pi-agent-core', 'pi-codemode', 'pi-mcp', 'pi-tui', 'chord']) {
    const path = require.resolve.paths('@earendil-works/' + name)?.map(directory => join(directory, '@earendil-works', name, 'package.json')).find(existsSync);
    if (!path) throw new Error(`Installed ${name} package not found`);
    const info = JSON.parse(readFileSync(path, 'utf8')); if (info.version !== '1.0.4') throw new Error(`Installed coupled ${name} drifted`); versions[name] = info.version;
  }
  installed = { candidateSha256: candidate.sha256, packageRoot, environment, versions, node: process.version, platform: process.platform };
  writeFileSync(record, JSON.stringify(installed, null, 2));
}
console.log(JSON.stringify(installed, null, 2));
if (['performance', 'native'].includes(process.argv[2])) {
  const action = process.argv[2];
  const source = readFileSync(join(root, action === 'native' ? 'scripts/live-native.ts' : 'scripts/performance.ts'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/from (['"])\.\.\/src\/([^'"]+)\1/g, "from './dist/$2'");
  const harness = join(installed.packageRoot, `_qualification-${action}.mjs`); writeFileSync(harness, compiled);
  execFileSync(process.execPath, [harness], { cwd: installed.packageRoot, stdio: 'inherit' });
}
