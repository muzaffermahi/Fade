import { openSync, closeSync, writeFileSync, fsyncSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute, sep } from 'node:path';
import { platform, arch } from 'node:os';
import { Type, type Static } from 'typebox';
import { VERSION, getShellConfig } from '@earendil-works/pi-coding-agent';
import { validate, type ProjectState } from './contracts.js';

const count = Type.Integer({ minimum: 0 });
const flag = Type.Union([Type.Boolean(), Type.Null()]);
/** Allowlisted support metadata contains no content, identifiers, paths, URLs or raw errors. */
export const DiagnosticReportSchema = Type.Object({ schemaVersion: Type.Literal(1), createdAt: Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$' }),
  fadeVersion: Type.String(), piVersion: Type.String(), environment: Type.Object({ node: Type.String(), platform: Type.String(), arch: Type.String(), supportedNode: Type.Boolean(), bashAvailable: Type.Boolean() }, { additionalProperties: false }),
  models: Type.Object({ builderSelected: Type.Boolean(), companionSelected: Type.Boolean(), builderAuthConfigured: flag, companionAuthConfigured: flag }, { additionalProperties: false }),
  state: Type.Object({ present: Type.Boolean(), version: Type.Union([count, Type.Null()]), storageFailureReported: Type.Boolean(), diagnosticNotices: count,
    executionOwner: Type.Union([Type.Literal('builder'), Type.Literal('companion'), Type.Null()]), runningSlices: count, recentInputs: count, pendingInputs: count, failedInputs: count }, { additionalProperties: false }),
}, { additionalProperties: false });
export type DiagnosticReport = Static<typeof DiagnosticReportSchema>;
/** Native runtime supplies live credential presence only, never secret values. */
export interface DiagnosticRuntime { builderAuthConfigured: boolean | null; companionAuthConfigured: boolean | null; bashAvailable?: boolean }
/** Match the supported CLI Node baseline without executing another process. */
export function supportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\./.exec(version); if (!match) return false;
  const major = Number(match[1]), minor = Number(match[2]); return major > 22 || major === 22 && minor >= 19;
}
/** Read-only snapshot. Only explicitly selected metadata is copied; raw payloads are never traversed. */
export function diagnosticReport(state: ProjectState | undefined, options: { builderModel?: string; companionModel?: string }, storageFailure: boolean, notices: number,
  runtime: DiagnosticRuntime = { builderAuthConfigured: null, companionAuthConfigured: null }, now = Date.now()): DiagnosticReport {
  const manifest = validate(Type.Object({ version: Type.String() }, { additionalProperties: true }), JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')));
  let bashAvailable = runtime.bashAvailable ?? false;
  if (runtime.bashAvailable === undefined) { try { bashAvailable = /(?:^|[/\\])bash(?:\.exe)?$/i.test(getShellConfig().shell); } catch { /* Presence unknown/missing; do not run a shell. */ } }
  return validate(DiagnosticReportSchema, { schemaVersion: 1, createdAt: new Date(now).toISOString(), fadeVersion: manifest.version, piVersion: VERSION,
    environment: { node: process.version, platform: platform(), arch: arch(), supportedNode: supportedNode(process.version), bashAvailable },
    models: { builderSelected: Boolean(options.builderModel), companionSelected: Boolean(options.companionModel), builderAuthConfigured: runtime.builderAuthConfigured, companionAuthConfigured: runtime.companionAuthConfigured },
    state: { present: Boolean(state), version: state?.version ?? null, storageFailureReported: storageFailure, diagnosticNotices: notices,
      executionOwner: state?.ownership.owner ?? null, runningSlices: state?.slices.filter(slice => slice.status === 'running').length ?? 0,
      recentInputs: state?.inputs.length ?? 0, pendingInputs: state?.inputs.filter(input => ['accepted', 'queued', 'processing'].includes(input.status)).length ?? 0,
      failedInputs: state?.inputs.filter(input => ['failed', 'interrupted'].includes(input.status)).length ?? 0 } });
}
/** Text is shared by local inspection and plain mode; no readiness statement implies endpoint reachability. */
export function doctorText(report: DiagnosticReport): string {
  const auth = (value: boolean | null) => value === null ? 'unknown; inspect /login' : value ? 'configured; endpoint not tested' : 'not configured; use /login';
  return `Local readiness · No provider call or workspace mutation.\nFade ${report.fadeVersion} · Pi ${report.piVersion}\nNode ${report.environment.node} · ${report.environment.platform}/${report.environment.arch}\n`
    + `Node requirement: ${report.environment.supportedNode ? 'met' : 'requires >=22.19'}\nBash: ${report.environment.bashAvailable ? 'found' : 'missing; install Bash/Git for Windows'}\n`
    + `Builder model: ${report.models.builderSelected ? 'selected' : 'choose /model or --builder'} · auth ${auth(report.models.builderAuthConfigured)}\n`
    + `Companion model: ${report.models.companionSelected ? 'selected' : 'choose /model'} · auth ${auth(report.models.companionAuthConfigured)}\n`
    + `Storage: ${report.state.storageFailureReported ? 'failure reported; repair and restart' : 'no reported failure'} · ${report.state.diagnosticNotices} notices\n`
    + `Execution owner: ${report.state.executionOwner ?? 'none'} · ${report.state.runningSlices} running slices\n`
    + `Active/recent receipts: ${report.state.recentInputs}; ${report.state.pendingInputs} pending; ${report.state.failedInputs} failed/interrupted\n`
    + 'Inspect /inputs and /status before /retry-input or /continue. Recovery never automatically replays uncertain work.\n'
    + 'Trusted local tools use your OS permissions; this is role coordination, not an OS sandbox.\n'
    + 'No provider call or workspace mutation was made. /bug-report previews content-free support metadata.';
}
/** Preview exactly the bytes an explicit local export will contain. */
export function diagnosticJson(report: unknown): string { return JSON.stringify(validate(DiagnosticReportSchema, report), null, 2) + '\n'; }
/** Explicit human export: canonical parent containment and exclusive creation prevent escaping or overwriting. */
export function exportDiagnostic(workspace: string, requested: string, report: DiagnosticReport): string {
  const name = validate(Type.String({ minLength: 1, maxLength: 4096, pattern: '^[^\\u0000-\\u001f]+$' }), requested);
  if (isAbsolute(name)) throw new Error('Use a relative export path below the workspace root.');
  const root = realpathSync(workspace), target = resolve(root, name), location = relative(root, target);
  if (!location || location.startsWith('..' + sep) || location === '..' || isAbsolute(location) || /^(?:\.fade|\.git)(?:[/\\]|$)/i.test(location)) throw new Error('Export must remain below the workspace root, outside protected state.');
  const parent = realpathSync(dirname(target)), parentLocation = relative(root, parent);
  if (parentLocation === '..' || parentLocation.startsWith('..' + sep) || isAbsolute(parentLocation)) throw new Error('Export parent escapes the canonical workspace root.');
  const canonical = resolve(parent, target.slice(dirname(target).length + 1));
  if (/^(?:\.fade|\.git)(?:[/\\]|$)/i.test(relative(root, canonical))) throw new Error('Export cannot write protected coordinator/Git state.');
  const bytes = diagnosticJson(report), descriptor = openSync(canonical, 'wx');
  try { writeFileSync(descriptor, bytes, 'utf8'); fsyncSync(descriptor); } finally { closeSync(descriptor); }
  return canonical;
}
