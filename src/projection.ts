import { truncateToWidth } from '@earendil-works/pi-tui';
import type { ProjectState } from './contracts.js';
import { Type, type Static } from 'typebox';
import { validate } from './contracts.js';
import { acceptanceStatus, verifiedSlice } from './checks.js';
import { terminalText } from './terminal-text.js';
/** Validated renderer boundary, shared by interactive and plain status. */
export const ProjectionSchema = Type.Object({ now: Type.String(), next: Type.String(), needsYou: Type.Optional(Type.String()),
  remaining: Type.Integer({ minimum: 0, maximum: 20 }), queues: Type.Array(Type.Object({ id: Type.String(), sessionId: Type.String(),
    role: Type.Union([Type.Literal('companion'), Type.Literal('builder')]), mode: Type.Union([Type.Literal('steer'), Type.Literal('followUp')]), text: Type.String() })),
  usage: Type.Object({ companion: Type.String(), builder: Type.String(), cost: Type.Literal('unknown') }) }, { additionalProperties: false });
export type WorkProjection = Static<typeof ProjectionSchema>;

/** Shared projection uses observed state, never footer notice strings. */
export function projectWork(state: ProjectState | undefined, now = Date.now()): WorkProjection {
  const active = state?.slices.find(s => s.status === 'running');
  const future = state?.slices.findLast(s => ['ready', 'draft', 'reconcile'].includes(s.status));
  const event = active ? state?.workEvents.findLast(e => e.sliceId === active.id) : undefined;
  const start = active ? state?.workEvents.find(e => e.sliceId === active.id && e.type === 'phase')?.timestamp : undefined;
  const conflict = state?.intent.decisions.find(d => d.status === 'conflict');
  const latest = state?.slices.findLast(s => s.status !== 'cancelled');
  const blocked = !active && latest?.status === 'blocked' ? latest : undefined;
  const awaiting = !active ? state?.slices.findLast(slice => slice.result?.status === 'completed' && ['completed', 'blocked'].includes(slice.status) && !verifiedSlice(slice)) : undefined;
  const uncertain = state?.inputs.filter(i => i.sessionId === state.currentSessionId && ['failed', 'interrupted'].includes(i.status)).length ?? 0;
  return validate(ProjectionSchema, {
    now: active ? `${active.plan.title} · ${event?.phase ?? 'inspecting'} · ${Math.max(0, Math.floor((now - (start ?? now)) / 1000))}s`
      : state?.mode === 'stopped' ? 'Builder stopped · /continue when ready' : state?.mode === 'paused' ? 'Builder paused · /continue when ready' : 'No active implementation',
    next: future ? `${future.plan.title}${future.plan.dependencies.some(id => state?.slices.some(slice => slice.id === id && !verifiedSlice(slice))) ? ' · held: required acceptance' : future.status === 'ready' ? '' : ` · held: ${future.status}`}` : 'No settled next slice; keep exploring',
    needsYou: conflict ? `Resolve intent conflict: ${conflict.key}` : awaiting ? acceptanceStatus(awaiting) === 'passed' ? 'Observed execution failure; dependent work held · /log'
      : `Acceptance ${acceptanceStatus(awaiting).replaceAll('_', ' ')}: ${awaiting.plan.title} · /builder for required checks`
      : blocked ? blocked.result?.summary ?? 'Builder blocked; /builder for details'
      : uncertain ? `${uncertain} interrupted/failed inputs saved · /inputs to inspect` : undefined,
    remaining: state?.remainingSlices ?? 4,
    queues: state?.inputs.filter(i => i.sessionId === state.currentSessionId && ['accepted', 'queued'].includes(i.status)).slice(-50).map(i => ({ id: i.id, sessionId: i.sessionId, role: i.role, mode: i.mode, text: i.text })) ?? [],
    usage: { companion: state?.usage?.companion ? `${state.usage.companion.tokens} tokens` : 'unknown',
      builder: state?.usage?.builder ? `${state.usage.builder.tokens} tokens` : 'unknown', cost: 'unknown' },
  });
}
/** One line per field avoids wrapping even in narrow terminals. */
export function workStrip(state: ProjectState | undefined, width: number, now = Date.now()): string[] {
  const p = projectWork(state, now);
  return [`Now: ${p.now}`, `Next: ${p.next}`, ...(p.needsYou ? [`Needs you: ${p.needsYou}`] : []),
    `Run: ${p.remaining} slices left · Cost: ${p.usage.cost}`].map(line => truncateToWidth(terminalText(line, 20000).replace(/\n/g, ' '), Math.max(1, width)));
}
