import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const candidate = json(join(root, 'releases/candidate.json'));
if (createHash('sha256').update(readFileSync(candidate.archive)).digest('hex') !== candidate.sha256) throw new Error('Candidate archive changed');
const record = join(root, 'releases/qualification.json'), history = join(root, 'releases/qualification-F09.json');
if (!existsSync(history)) {
  const previous = readFileSync(record);
  if (JSON.parse(previous.toString('utf8')).workOrder !== 'F09') throw new Error('Expected historical F09 record before replacement');
  writeFileSync(history, previous, { flag: 'wx' });
}
const windows24 = 'C:/Users/LENOVO/AppData/Local/Temp/fade-package-smoke-gHDda7/smoke.json';
const windows22 = join(root, 'output/readiness-F25-node22-artifact.json');
const installed = json(join(root, 'output/installed-qualification.json'));
const performance = 'C:/Users/LENOVO/AppData/Local/Temp/fade-performance-1MFywl/metrics.json';
const performanceRerun = 'C:/Users/LENOVO/AppData/Local/Temp/fade-performance-x8oBkl/metrics.json';
const cloud = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-MRCU3H/evaluation.json';
const local = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-Cza22Q/evaluation.json';
const nativeCloud = 'C:/Users/LENOVO/AppData/Local/Temp/fade-native-tools-KQzwUt/evaluation.json';
const step = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-8SBjD0/evaluation.json';
const hybrid = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-8DRIwP/evaluation.json';
const recovery = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-8DRIwP/recovery-evaluation.json';
const qwopus = 'C:/Users/LENOVO/AppData/Local/Temp/fade-candidate-live-acq8Cu/evaluation.json';
const wsl = json(join(root, 'output/readiness-F25-wsl-artifact.json'));
if (wsl.candidateSha256 !== candidate.sha256 || wsl.previousSha256 !== candidate.previous.sha256 || wsl.results.some(result => result.result?.platform !== 'linux' || result.result?.node !== `v${result.version}` || result.result?.candidateSha256 !== candidate.sha256)) throw new Error('WSL runtime/artifact evidence identity mismatch');
for (const evidence of [json(windows24), json(windows22), installed, ...[cloud, local, step, hybrid, recovery, qwopus].filter(existsSync).map(json)]) {
  if ((evidence.candidateSha256 ?? evidence.sha256) !== candidate.sha256) throw new Error('Evidence hash mismatch');
}
const provider = path => existsSync(path) ? { evidence: path, ...json(path) } : { evidence: path, status: 'No terminal evidence recorded', passed: false };
writeFileSync(record, JSON.stringify({
  date: new Date().toISOString(), workOrder: 'F25', name: candidate.name, version: candidate.version,
  archive: candidate.archive, sha256: candidate.sha256, qualifiedRelease: false,
  historicalRecord: 'releases/qualification-F09.json',
  sourceEngineering: { workOrders: 'F13–F24', tests: 177, passed: true, evidence: 'output/readiness-F24-verify.log', scope: 'Source tests/build; not installed-product or external qualification' },
  helperVerification: { tests: 6, passed: true, sourceAndTestTypeScript: 'passed', evidence: 'output/readiness-F25-recovery-guards.log', typeScriptEvidence: 'output/readiness-F25-recovery-types.log' },
  windowsLocalInstall: [{ evidence: windows24, ...json(windows24) }, { evidence: windows22, ...json(windows22) }],
  linuxWslInstall: { ...wsl, evidence: 'output/readiness-F25-wsl-artifact.json', kernelEvidence: 'output/readiness-F25-wsl-environment.log' },
  linuxWslPerformance: { ...json(join(root, 'output/readiness-F25-wsl-performance.json')), evidence: 'output/readiness-F25-wsl-performance.json',
    preservedFirstPass: 'output/readiness-F25-wsl-performance-first-pass.json', setupFailure: 'output/readiness-F25-wsl-performance-setup-failure.json' },
  installedDependencies: installed,
  npmScopeOwnership: json(join(root, 'output/readiness-F25-scope-owner.json')),
  performance: { passed: false, evidence: performance, measurements: json(performance), phaseProbe: 'output/readiness-F25-startup-probe.log',
    controlledRerun: { passed: true, evidence: performanceRerun, measurements: json(performanceRerun), log: 'output/readiness-F25-installed-performance-rerun.log', condition: 'Temporary local server off/model unloaded; original benchmark unchanged' },
    reason: 'First warm startup 2621.77ms exceeds 2000ms; controlled rerun passes all targets, but variability remains unexplained and physical timing is unqualified' },
  providers: { freeCloud: provider(cloud), cachedLocal: { ...provider(local),
    termination: 'Harness stopped temporary local server after repeated Companion reads of nonexistent notebook.mjs/README.md; not a deadline result',
    cleanup: 'Temporary server off, qualification model unloaded; normal Pi settings unchanged', cleanupEvidence: 'output/readiness-F25-local-cleanup.log'
  }, freeStep: provider(step), hybridCloudCompanionLocalBuilder: provider(hybrid), cachedQwopusBuilder: {
    ...provider(qwopus), cleanupEvidence: 'output/readiness-F25-qwopus-cleanup.log'
  }, assistedHybridRecovery: {
    ...provider(recovery), termination: 'Harness stopped provider after repeated combined acceptance commands and dependent edits attributed to the foundation slice',
    deviations: ['Exact foundation acceptance command not observed', 'Dependent search implementation and test written during foundation attempt'],
    cleanupEvidence: 'output/readiness-F25-recovery-cleanup.log'
  }, stepAvailability: json(join(root, 'output/readiness-F25-step-availability.json')), nativeCloudInspection: {
    ...provider(nativeCloud), candidateSha256: candidate.sha256, packageRoot: installed.packageRoot,
    harness: 'node scripts/qualification-installed.mjs native', log: 'output/readiness-F25-installed-cloud-native.log',
    scope: 'Installed native Companion file-only marker and explicit human shell; no Builder A→B or physical terminal claim'
  } },
  ci: { status: 'prepared, not run', matrix: 'Windows/macOS/Linux × Node22/24', sourceAndExactArtifactJobs: true, reason: 'No push/publication authorization; exact artifact jobs require accessible archive URLs' },
  openGates: ['G52/G53 actual six-cell CI and clean-machine installation', 'G54 physical Windows/macOS/Linux terminal/IME/Unicode/theme/paste/resize/scroll/streaming matrix', 'G54 five unfamiliar developers, at least four uncoached successes', 'G56 successful exact-artifact cloud/local full workflow and native journey', 'G58 startup consistency ≤2s and physical hardware timing', 'npm scope ownership unverified (existing account check ENEEDAUTH)', 'F26 qualified-artifact launch demo and final handoff', 'Zero data loss and unintended execution across the complete qualification matrix'],
  commitsPushesPublications: 'none'
}, null, 2) + '\n');
console.log('Current qualification record written; qualifiedRelease=false');
