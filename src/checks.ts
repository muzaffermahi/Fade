import { randomUUID } from 'node:crypto';
import { AcceptanceCheckSchema, CheckDefinitionSchema, validate, type AcceptanceCheck, type CheckDefinition, type Plan, type ProjectState, type Slice } from './contracts.js';
import { isCheckCommand } from './activity.js';

function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
/** Legacy prose is manual; recognizable legacy commands retain their exact invocation. */
export function checkDefinition(value: NonNullable<Plan['acceptanceChecks']>[number]): CheckDefinition {
  const definition = typeof value === 'string' ? isCheckCommand(value) ? { kind: 'executable', criterion: value, command: value.trim() } : { kind: 'manual', criterion: value } : value;
  const checked = validate(CheckDefinitionSchema, structuredClone(definition));
  if (!checked.criterion.trim() || (checked.kind === 'executable' && !checked.command.trim())) throw new Error('Acceptance criterion and command must be nonempty.');
  return checked;
}
/** Inject identity for deterministic tests; existing histories/identities are retained on a new attempt. */
export function prepareChecks(plan: Plan, afterSequence = 0, existing: AcceptanceCheck[] = [], uuid: () => string = randomUUID): AcceptanceCheck[] {
  return (plan.acceptanceChecks ?? []).map((value, index) => {
    const definition = checkDefinition(value), previous = existing[index];
    if (previous && JSON.stringify(previous.definition) !== JSON.stringify(definition)) throw new Error('Acceptance definition changed outside the immutable brief.');
    return validate(AcceptanceCheckSchema, { id: previous?.id ?? uuid(), definition, afterSequence,
      status: definition.kind === 'manual' ? 'needs_human_inspection' : 'not_run', history: previous?.history ?? [],
      ...(previous?.latestResult ? { latestResult: previous.latestResult } : {}) });
  });
}
/** Missing or empty check records can never establish verified acceptance. */
export function acceptanceStatus(slice: Slice): AcceptanceCheck['status'] {
  const checks = slice.checks;
  if (!checks?.length || checks.length !== slice.plan.acceptanceChecks?.length) return 'not_run';
  if (checks.some((check, index) => {
    const value = slice.plan.acceptanceChecks?.[index];
    const latest = check.history.findLast(attempt => check.definition.kind === 'manual' ? attempt.source === 'human' : attempt.source === 'execution' && attempt.sequence > check.afterSequence);
    return value === undefined || JSON.stringify(check.definition) !== JSON.stringify(checkDefinition(value)) || (check.status === 'passed' && latest?.status !== 'passed');
  })) return 'not_run';
  if (checks.some(check => check.status === 'failed')) return 'failed';
  if (checks.some(check => check.status === 'running')) return 'running';
  if (checks.every(check => check.status === 'passed')) return 'passed';
  if (checks.some(check => check.definition.kind === 'executable' && check.status !== 'passed')) return 'not_run';
  return 'needs_human_inspection';
}
/** Only completed implementation with passed required checks may unlock automatic dependencies. */
export function verifiedSlice(slice: Slice): boolean { return slice.status === 'completed' && slice.result?.status === 'completed' && acceptanceStatus(slice) === 'passed'; }

function command(payload: unknown): string | undefined {
  return object(payload) && object(payload.args) && typeof payload.args.command === 'string' ? payload.args.command.trim() : undefined;
}
function resultText(value: unknown): string {
  if (object(value) && Array.isArray(value.content)) {
    const text = value.content.filter(object).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n');
    if (text.trim()) return text.slice(0, 4000);
  }
  return 'Observed stock tool result has no textual output.';
}
/** Pure evaluation of paired public tool events. Report prose, orphan ends and stale passes cannot count. */
export function observeChecks(slice: Slice, state: Pick<ProjectState, 'workEvents' | 'verificationEvidence'>, quiesced = false): AcceptanceCheck[] {
  const events = state.workEvents.filter(event => event.sliceId === slice.id);
  const definitions = slice.checks ?? [];
  const mutation = events.filter(event => event.type === 'tool_start' && (['write', 'edit'].includes(event.toolName ?? '')
    || (['bash', 'powershell'].includes(event.toolName ?? '') && !definitions.some(check => check.definition.kind === 'executable' && check.definition.command.trim() === command(event.payload)))))
    .at(-1)?.sequence ?? 0;
  return definitions.map(original => {
    const check = structuredClone(original); if (check.definition.kind === 'manual') return check;
    const exact = check.definition.command.trim();
    const starts = events.filter(event => event.type === 'tool_start' && ['bash', 'powershell'].includes(event.toolName ?? '') && event.sequence > check.afterSequence && command(event.payload) === exact);
    for (const evidence of state.verificationEvidence.filter(evidence => evidence.sliceId === slice.id && evidence.sequence > check.afterSequence)) {
      const end = events.find(event => event.sequence === evidence.sequence && event.type === 'tool_end' && event.operationId === evidence.operationId && event.toolName === evidence.toolName);
      const prior = events.findLast(event => event.sequence < evidence.sequence && event.operationId === evidence.operationId && ['tool_start', 'tool_end'].includes(event.type));
      if (!end || !prior || prior.type !== 'tool_start' || !starts.includes(prior) || prior.toolName !== evidence.toolName
        || !object(evidence.input) || evidence.input.type !== 'tool_execution_start' || evidence.input.toolCallId !== evidence.operationId || evidence.input.toolName !== evidence.toolName
        || command(evidence.input) !== exact || !object(end.payload) || typeof end.payload.isError !== 'boolean' || end.payload.isError !== evidence.isError) continue;
      if (check.history.some(attempt => attempt.source === 'execution' && attempt.sequence === evidence.sequence)) continue;
      const details = object(evidence.result) && object(evidence.result.details) ? evidence.result.details : undefined;
      const failed = evidence.isError || (typeof details?.exitCode === 'number' && details.exitCode !== 0);
      check.history.push({ source: 'execution', sequence: evidence.sequence, operationId: evidence.operationId, toolName: evidence.toolName,
        timestamp: evidence.timestamp, status: failed ? 'failed' : 'passed', evidence: resultText(evidence.result) });
    }
    const latest = check.history.findLast(attempt => attempt.source === 'execution' && attempt.sequence > check.afterSequence);
    const start = starts.at(-1);
    if (start && (!latest || latest.source !== 'execution' || start.sequence > latest.sequence)) { check.status = 'running'; check.latestResult = 'Observed execution started; no paired final result yet.'; }
    else if (latest?.source === 'execution') {
      check.status = latest.status; check.latestResult = latest.evidence;
      if (latest.status === 'passed' && mutation > latest.sequence) { check.status = 'not_run'; check.latestResult = 'Workspace mutation occurred after this pass; rerun this exact check.'; }
    } else { check.status = 'not_run'; check.latestResult = 'No paired execution of this exact required command observed in this attempt.'; }
    if (quiesced && check.status === 'running') { check.status = 'not_run'; check.latestResult = 'Execution quiesced without a paired final result; explicit rerun required.'; }
    return validate(AcceptanceCheckSchema, check);
  });
}
/** Text for all surfaces includes stable IDs needed for an explicit human inspection decision. */
export function checkReport(slice: Slice): string {
  return `Acceptance: ${acceptanceStatus(slice).replaceAll('_', ' ')}\n` + (slice.checks?.map(check =>
    `- ${check.id} · ${check.status.replaceAll('_', ' ')} · ${check.definition.criterion}${check.definition.kind === 'executable' ? `\n  Exact command: ${check.definition.command}` : `\n  Human: /accept-check ${slice.id} ${check.id} pass|fail <inspection evidence>`}`
    + `\n  ${check.latestResult ?? 'No result yet.'} · ${check.history.length} retained attempts`).join('\n') || 'No required check records; unverified.');
}
