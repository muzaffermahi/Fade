import { existsSync, readFileSync, writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { npmCli } from './npm-cli.mjs';
const root = dirname(dirname(fileURLToPath(import.meta.url))), candidate = JSON.parse(readFileSync(join(root, 'releases/candidate.json'), 'utf8'));
const archive = resolve(process.argv[2] ?? candidate.archive), hash = createHash('sha256').update(readFileSync(archive)).digest('hex');
if (archive !== resolve(candidate.archive) || hash !== candidate.sha256) throw new Error('Use the recorded candidate archive with its matching checksum');
const previous = candidate.previous;
if (!previous || previous.version === candidate.version || createHash('sha256').update(readFileSync(previous.archive)).digest('hex') !== previous.sha256) throw new Error('Real previous archive/checksum required');
const environment = mkdtempSync(join(tmpdir(), 'fade-package-smoke-')), prefix = join(environment, 'global install'), workspace = join(environment, 'project 空间'); mkdirSync(workspace);
const env = { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_CODING_AGENT_DIR: join(environment, 'isolated pi') }; mkdirSync(env.PI_CODING_AGENT_DIR);
const runNpm = (...args) => execFileSync(process.execPath, [npmCli(), ...args], { env, encoding: 'utf8', maxBuffer: 10000000 });
const install = path => runNpm('install', '--global', '--prefix', prefix, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', path);
const modules = () => runNpm('root', '--global', '--prefix', prefix).trim();
const command = (cli, input) => {
  const result = spawnSync(process.execPath, [cli, '--plain', '--workspace', workspace, '--builder', 'fixture/missing', '--companion', 'fixture/missing'], { env, input, encoding: 'utf8', timeout: 30000 });
  if (result.status !== 0 || existsSync(join(workspace, '.fade', 'lock'))) throw new Error('Packaged plain launch/lock cleanup failed: ' + result.stderr + ' ' + result.stdout);
  return result.stdout;
};
console.log('Isolated previous-archive to scoped-global upgrade rehearsal: ' + environment);
const previousDirectory = join(environment, 'previous archive'); mkdirSync(previousDirectory);
execFileSync('tar', ['-xf', previous.archive, '-C', previousDirectory]);
const older = join(previousDirectory, 'package'), oldManifest = JSON.parse(readFileSync(join(older, 'package.json'), 'utf8'));
if (oldManifest.version !== previous.version || oldManifest.name !== previous.name) throw new Error('Installed previous identity does not match evidence');
// Install the actual historical archive's locked tree as its project root. Fresh global installs of that old artifact ignore its transitive overrides.
runNpm('ci', '--prefix', older, '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund');
command(join(older, oldManifest.bin.Fade), 'Synthetic previous-version migration idea\n/quit\n');
const before = JSON.parse(readFileSync(join(workspace, '.fade', 'state.json'), 'utf8'));
if (!before.conversation?.some(item => item.text === 'Synthetic previous-version migration idea')) throw new Error('Previous CLI did not create preserved provenance');
install(archive);
const installed = join(modules(), candidate.name), manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
if (manifest.name !== candidate.name || manifest.version !== candidate.version || manifest.version === oldManifest.version) throw new Error('Upgrade must install a different recorded version');
if (!existsSync(join(installed, 'npm-shrinkwrap.json'))) throw new Error('Distributed dependency lock missing');
for (const alias of ['Fade', 'fade']) {
  const target = manifest.bin?.[alias]; if (typeof target !== 'string') throw new Error('Missing ' + alias + ' alias');
  const shim = platform() === 'win32' ? join(prefix, alias + '.cmd') : join(prefix, 'bin', alias);
  if (!existsSync(shim)) throw new Error('Global ' + alias + ' shim missing');
  const help = platform() === 'win32' ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', shim, '--help'], { env, encoding: 'utf8' }) : execFileSync(shim, ['--help'], { env, encoding: 'utf8' });
  if (!help.includes('Fade')) throw new Error('Installed ' + alias + ' help missing');
}
const cli = join(installed, manifest.bin.Fade), output = command(cli, '/status\n/doctor\n/bug-report\n/bug-report export report.json\n/quit\n');
if (!output.includes('Now:') || !output.includes('No provider call') || !existsSync(join(workspace, 'report.json'))) throw new Error('Packaged status/doctor/export missing');
const after = JSON.parse(readFileSync(join(workspace, '.fade', 'state.json'), 'utf8'));
if (after.id !== before.id || after.version !== 5 || !after.conversation?.some(item => item.text === 'Synthetic previous-version migration idea') || after.mode !== 'paused') throw new Error('Real upgrade failed preserved provenance/paused v5 migration');
const config = execFileSync(process.execPath, ['--input-type=module', '-e', "import { ModelRuntime } from '@earendil-works/pi-coding-agent'; const runtime=await ModelRuntime.create({refreshOnCreate:false}); if(!runtime.getModels().length)throw new Error('Missing model registry'); console.log('CONFIG_OK');"], { env, cwd: installed, encoding: 'utf8' });
if (!config.includes('CONFIG_OK')) throw new Error('Packaged native configuration API failed');
runNpm('uninstall', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', manifest.name);
if (existsSync(installed)) throw new Error('Isolated uninstall left the package');
if (!existsSync(join(workspace, '.fade', 'journal.jsonl')) || !existsSync(join(workspace, 'report.json'))) throw new Error('Uninstall removed project history/export');
const evidence = { platform: platform(), node: process.version, archive, sha256: hash, previous: { ...previous, installedVersion: oldManifest.version, stateVersion: before.version }, environment,
  checks: ['actual previous archive locked install', 'previous CLI creates provenance without a provider call', 'different-version scoped global upgrade', 'Fade/fade global shims execute', 'paused v5 migration preserves project/history', 'local doctor/preview/exclusive export', 'native configuration APIs', 'isolated uninstall preserves workspace'],
  scope: 'Local host rehearsal from exact archives; clean-machine/platform/physical/provider/participant qualification remains separate' };
writeFileSync(join(environment, 'smoke.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));

