import { sessionConversation, type ProjectState, type Slice } from './contracts.js';
import type { ToolOperation } from './activity.js';
import { checkDefinition, checkReport, acceptanceStatus } from './checks.js';
import { terminalText } from './terminal-text.js';

/** Human-readable Builder result; verification remains explicitly attributed to its report. */
export function sliceReport(slice: Slice): string {
  const checks = slice.result?.verification ?? [];
  return terminalText(`Builder · ${slice.plan.title} · ${slice.status}\nImplementation reported: ${slice.result?.status ?? 'no outcome'}\n${checkReport(slice)}\n\n${slice.result?.summary ?? slice.plan.goal}`
    + (checks.length ? `\n\nChecks reported:\n${checks.map(check => `- ${check}`).join('\n')}` : '\n\nNo verification report yet.')
    + (slice.result?.discoveries.length ? `\n\nFindings:\n${slice.result.discoveries.map(d => `- ${d.summary}`).join('\n')}` : ''), 500000);
}
/** Completion card keeps observed operations separate from the model's report. */
export function outcomeCard(state: ProjectState, slice: Slice): string {
  const evidence = state.verificationEvidence.filter(e => e.sliceId === slice.id);
  const checks = evidence.filter(e => ['bash', 'powershell'].includes(e.toolName));
  const future = state.slices.find(s => ['ready', 'draft', 'reconcile'].includes(s.status));
  return terminalText(`Builder · ${slice.plan.title} · ${slice.status}\n${slice.result?.summary ?? slice.plan.goal}`
    + `\nObserved: ${evidence.length} completed tool operations; ${checks.filter(e => !e.isError).length} successful shell results, ${checks.filter(e => e.isError).length} failed.`
    + `\nReported checks: ${slice.result?.verification.join('; ') || 'none'}`
    + `\nImplementation reported: ${slice.result?.status ?? 'no outcome'} · acceptance: ${acceptanceStatus(slice).replaceAll('_', ' ')}`
    + `\n${checkReport(slice)}`
    + '\nLimits: shell success does not establish all acceptance criteria; external edits have uncertain attribution.'
    + `\nNext: ${future?.plan.title ?? 'No settled future slice.'} · /changes · /builder · /log`, 500000);
}
export function builderReport(state: ProjectState): string {
  const current = state.slices.find(s => s.status === 'running') ?? state.slices.at(-1);
  const notes = (state.builderMessages ?? []).slice(-6);
  return terminalText((current ? sliceReport(current) : 'Builder has no slice yet.')
    + (current ? `\n\nBrief ${current.id} · intent revision ${current.snapshot?.intent.revision ?? state.intent.revision}${current.snapshot ? ' · frozen at start' : ' · not started'}\nGoal: ${current.snapshot?.goal ?? current.plan.goal}`
      + `\nRequirements:\n${(current.snapshot?.requirements ?? current.plan.requirements).map(r => `- ${r}`).join('\n') || 'None'}\nAcceptance checks:\n${current.plan.acceptanceChecks?.map(r => `- ${checkDefinition(r).criterion}`).join('\n') || 'None supplied'}\nDependencies: ${current.plan.dependencies.join(', ') || 'none'}\nAssumptions: ${current.plan.assumptions.join('; ') || 'none'}`
      + `\nIntent references:\n${current.plan.decisionKeys.map(key => {
        const decision = (current.snapshot?.intent ?? state.intent).decisions.find(d => d.key === key && d.status === 'active');
        return `- ${key}: ${decision?.text ?? 'Reference unavailable'}${decision ? `\n  Human source ${decision.sourceId}: ${decision.quote}` : ''}`;
      }).join('\n') || 'None supplied'}` : '')
    + (notes.length ? `\n\nYour Builder notes:\n${notes.map(n => `- ${n.id.slice(0, 8)} · ${n.status}: ${n.text}`).join('\n')}` : '')
    + '\n\n/builder <message> sends a note. /redirect changes scope explicitly.', 500000);
}
/** A single observed call card, updated in place; expanded output remains bounded. */
export function operationCard(operation: ToolOperation, expanded: boolean, now = Date.now(), details: '/log' | '/pi' = '/log'): string {
  const duration = Math.max(0, Math.floor(((operation.endedAt ?? now) - operation.startedAt) / 1000));
  const status = operation.endedAt === undefined ? 'running' : operation.failed ? 'failed' : 'finished';
  const output = operation.output || 'Awaiting output';
  return terminalText(`${operation.tool} · ${status} · ${duration}s${operation.target ? ` · ${operation.target}` : ''}`
    + `\n${expanded ? output : output.split('\n').slice(0, 2).join('\n').slice(0, 240)}`
    + (expanded ? `\n[Ctrl+O collapses · ${details} for retained output]` : `\n[Ctrl+O expands tools · ${details} for retained output]`), 6000);
}
export function reports(state: ProjectState): string {
  const companion = sessionConversation(state).filter(m => m.role === 'companion').at(-1);
  return terminalText(`Companion · latest reply\n\n${companion?.text ?? 'No reply yet.'}\n\n`
    + state.slices.slice(-6).map(sliceReport).join('\n\n---\n\n'), 500000);
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
/** Bounded observed text, including honest absence of text for non-text tools. */
export function observedOutput(result: unknown, maxOutput = 1500): string {
  if (!object(result) || !Array.isArray(result.content)) return 'No textual output recorded.';
  const output = result.content.filter(object).filter(c => c.type === 'text' && typeof c.text === 'string')
    .map(c => String(c.text)).join('\n');
  return output ? terminalText(output, maxOutput) + (output.length > maxOutput ? '\n[Output truncated; inspect /log for more.]' : '') : 'No textual output recorded.';
}
/** Formats the same observed event for live work and retained execution history. */
export function toolActivity(event: unknown, maxOutput = 1500): string {
  if (typeof event === 'string') return terminalText(event, maxOutput);
  if (!object(event)) return '';
  if (event.type === 'tool_execution_start') {
    const args = object(event.args) ? event.args : {};
    const detail = typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : '';
    return terminalText(`${String(event.toolName)} · started${detail ? ` · ${detail}` : ''}`, maxOutput);
  }
  if (event.type === 'tool_execution_update') return `${String(event.toolName)} · streaming\n${observedOutput(event.partialResult, maxOutput)}`;
  if (event.type === 'tool_execution_end') return `${String(event.toolName)} · ${event.isError ? 'failed' : 'finished'}\n${observedOutput(event.result, maxOutput)}`;
  return '';
}
/** Present actual events without dumping transport JSON into the conversation. */
export function executionLog(raw: string, maxRecords = 40, maxOutput = 1500): string {
  return raw.trim().split('\n').slice(-maxRecords).flatMap(line => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return ['Unreadable event (raw log retained on disk).']; }
    if (!object(record) || !object(record.event)) return [];
    const formatted = toolActivity(record.event.event, maxOutput);
    return formatted ? [formatted] : [];
  }).join('\n\n') || 'No Builder tool events yet.';
}
