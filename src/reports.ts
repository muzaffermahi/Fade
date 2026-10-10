import type { ProjectState, Slice } from './contracts.js';

/** Human-readable Builder result; verification remains explicitly attributed to its report. */
export function sliceReport(slice: Slice): string {
  const checks = slice.result?.verification ?? [];
  return `Builder · ${slice.plan.title} · ${slice.status}\n\n${slice.result?.summary ?? slice.plan.goal}`
    + (checks.length ? `\n\nChecks reported:\n${checks.map(check => `- ${check}`).join('\n')}` : '\n\nNo verification report yet.')
    + (slice.result?.discoveries.length ? `\n\nFindings:\n${slice.result.discoveries.map(d => `- ${d.summary}`).join('\n')}` : '');
}
export function builderReport(state: ProjectState): string {
  const current = state.slices.find(s => s.status === 'running') ?? state.slices.at(-1);
  const notes = (state.builderMessages ?? []).slice(-6);
  return (current ? sliceReport(current) : 'Builder has no slice yet.')
    + (notes.length ? `\n\nYour Builder notes:\n${notes.map(n => `- ${n.id.slice(0, 8)} · ${n.status}: ${n.text}`).join('\n')}` : '')
    + '\n\n/builder <message> sends a note. /redirect changes scope explicitly.';
}
export function reports(state: ProjectState): string {
  const companion = state.conversation.filter(m => m.role === 'companion').at(-1);
  return `Companion · latest reply\n\n${companion?.text ?? 'No reply yet.'}\n\n`
    + state.slices.slice(-6).map(sliceReport).join('\n\n---\n\n');
}

function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }
/** Present actual events without dumping transport JSON into the conversation. */
export function executionLog(raw: string): string {
  return raw.trim().split('\n').slice(-40).flatMap(line => {
    let record: unknown;
    try { record = JSON.parse(line); } catch { return ['Unreadable event (raw log retained on disk).']; }
    if (!object(record) || !object(record.event)) return [];
    const event = record.event.event;
    if (typeof event === 'string') return [event];
    if (!object(event)) return [];
    if (event.type === 'tool_execution_start') {
      const args = object(event.args) ? event.args : {};
      const detail = typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : '';
      return [`${String(event.toolName)} · ${detail}`];
    }
    if (event.type === 'tool_execution_end' && object(event.result) && Array.isArray(event.result.content)) {
      const output = event.result.content.filter(object).filter(c => c.type === 'text' && typeof c.text === 'string')
        .map(c => String(c.text)).join('\n').slice(0, 1500);
      return [`${String(event.toolName)} · ${event.isError ? 'failed' : 'finished'}\n${output}`];
    }
    return [];
  }).join('\n\n') || 'No Builder tool events yet.';
}
