import { ActivitySchema, validate, type RoleActivity } from './contracts.js';
import { observedOutput } from './reports.js';
import { terminalText } from './terminal-text.js';

type Role = RoleActivity['role'];
const busy = new Set<RoleActivity['state']>(['preparing', 'waiting_for_provider', 'streaming', 'inspecting', 'executing', 'checking', 'cancelling']);
/** Bound untrusted provider/tool text and remove terminal control sequences. */
export function visibleText(value: string, limit = 2000): string {
  return terminalText(value, limit);
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
/** Label only simple recognized check commands; a compound shell is generic execution. */
export function isCheckCommand(raw: string): boolean {
  const command = raw.trim();
  return !/[\r\n;&|<>]/.test(command) && /^(node\s+(--check\s+|--test\b|[^ ]*test[^ ]*\.(?:mjs|cjs|js)\b)|npm\s+test\b|(?:pytest|tsc|vitest)\b|cargo\s+(?:test|check)\b)/.test(command);
}
/** A bounded observed operation, separate from model verification claims. */
export interface ToolOperation {
  id: string; tool: string; target: string; startedAt: number; updatedAt: number;
  endedAt?: number; failed: boolean; output: string;
}
/** Event-driven runtime activity. Clock and notifications are injectable; no persistence or provider calls. */
export class ActivityTracker {
  private readonly roles: Record<Role, RoleActivity>;
  private readonly prose: Record<Role, string> = { builder: '', companion: '' };
  private readonly operations: Record<Role, Map<string, ToolOperation>> = { builder: new Map(), companion: new Map() };
  // Only in-flight identity/timing metadata survives card eviction. It is removed
  // on completion, so long histories remain bounded without hiding parallel work.
  private readonly running: Record<Role, Map<string, Pick<ToolOperation, 'id' | 'tool' | 'target' | 'startedAt'>>> = { builder: new Map(), companion: new Map() };
  private readonly listeners = new Set<() => void>();
  constructor(private readonly clock: () => number = Date.now) {
    const ready = (role: Role): RoleActivity => validate(ActivitySchema, { role, sessionId: 'welcome', operationId: 'idle', state: 'ready', phase: 'Ready',
      startedAt: clock(), lastActivityAt: clock(), queueCount: 0, cancellationRequested: false, recovery: [] });
    this.roles = { builder: ready('builder'), companion: ready('companion') };
  }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  get(role: Role): RoleActivity { return structuredClone(this.roles[role]); }
  liveText(role: Role): string { return this.prose[role]; }
  tools(role: Role): ToolOperation[] { return [...this.operations[role].values()].map(operation => ({ ...operation })); }
  get active(): boolean { return Object.values(this.roles).some(activity => busy.has(activity.state)); }
  /** Reset session conversation activity without touching the other role's workspace operation. */
  reset(role: Role, sessionId: string): void {
    this.prose[role] = ''; this.operations[role].clear(); this.running[role].clear();
    this.set(role, { role, sessionId, operationId: 'idle', state: 'ready', phase: 'Ready', startedAt: this.clock(), lastActivityAt: this.clock(), queueCount: 0, cancellationRequested: false, recovery: [] });
  }
  begin(role: Role, sessionId: string, operationId: string): void {
    this.prose[role] = ''; this.operations[role].clear(); this.running[role].clear();
    this.set(role, { role, sessionId, operationId, state: 'preparing', phase: 'Preparing request', startedAt: this.clock(), lastActivityAt: this.clock(), queueCount: this.roles[role].queueCount,
      cancellationRequested: false, recovery: [], ...(this.roles[role].usage ? { usage: this.roles[role].usage } : {}) });
  }
  update(role: Role, state: RoleActivity['state'], phase: string): void {
    if (this.roles[role].cancellationRequested && state !== 'paused' && state !== 'failed') return;
    this.set(role, { ...this.roles[role], state, phase: visibleText(phase, 1000), lastActivityAt: this.clock() });
  }
  queue(role: Role, sessionId: string, count: number): void {
    const current = this.roles[role];
    this.set(role, { ...current, ...(!busy.has(current.state) && count > 0 ? { sessionId, state: 'queued', phase: 'Saved; awaiting delivery' }
      : current.state === 'queued' && count === 0 ? { state: 'ready', phase: 'Ready' } : {}), queueCount: count });
  }
  usage(role: Role, tokens: number, context?: { contextUsed?: number; contextWindow?: number }): void {
    this.set(role, { ...this.roles[role], usage: { ...this.roles[role].usage, tokens, ...context } });
  }
  cancel(role: Role): void {
    if (!busy.has(this.roles[role].state)) return;
    this.set(role, { ...this.roles[role], state: 'cancelling', phase: 'Waiting for active work to stop', cancellationRequested: true, lastActivityAt: this.clock() });
  }
  finish(role: Role, state: 'completed' | 'paused' | 'blocked' | 'failed', error?: string, recovery: RoleActivity['recovery'] = []): void {
    const { tool: _tool, target: _target, command: _command, error: _error, ...current } = this.roles[role];
    this.set(role, { ...current, state, phase: state === 'paused' ? 'Paused; inspect retained work' : state,
      lastActivityAt: this.clock(), recovery, ...(error ? { error: visibleText(error) } : {}) });
    this.prose[role] = ''; this.emit();
    this.running[role].clear();
  }
  /** Public Pi session events enter here; malformed and unrelated events are ignored. */
  observe(role: Role, event: unknown): void {
    if (!object(event)) return;
    if (event.type === 'activity_cancel') { this.cancel(role); return; }
    if (event.type === 'role_context' && typeof event.tokens === 'number' && Number.isSafeInteger(event.tokens) && event.tokens >= 0
      && typeof event.contextWindow === 'number' && Number.isSafeInteger(event.contextWindow) && event.contextWindow > 0) {
      this.usage(role, event.tokens, { contextWindow: event.contextWindow, ...(typeof event.contextUsed === 'number' && Number.isSafeInteger(event.contextUsed) && event.contextUsed >= 0 ? { contextUsed: event.contextUsed } : {}) }); return;
    }
    if (!busy.has(this.roles[role].state) || this.roles[role].cancellationRequested) return;
    if (event.type === 'message_update' && object(event.message) && event.message.role === 'assistant' && Array.isArray(event.message.content)) {
      const content = event.message.content.filter(object);
      this.prose[role] = visibleText(content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => String(block.text)).join('\n'), 6000);
      this.update(role, 'streaming', this.prose[role] ? 'Receiving response' : 'Provider is thinking'); return;
    }
    if (event.type === 'auto_retry_start') { this.update(role, 'waiting_for_provider', `Provider retry ${String(event.attempt)}/${String(event.maxAttempts)} in ${String(event.delayMs)}ms: ${String(event.errorMessage)}`); return; }
    if (event.type === 'auto_retry_end') { this.update(role, 'waiting_for_provider', event.success ? 'Provider retry completed' : `Provider retry ended: ${String(event.finalError ?? 'Waiting for result')}`); return; }
    if (event.type === 'compaction_start') { this.update(role, 'preparing', 'Compacting provider context'); return; }
    if (event.type === 'compaction_end') { this.update(role, 'waiting_for_provider', event.aborted ? 'Context compaction cancelled' : `Context compaction ${event.errorMessage ? `failed: ${String(event.errorMessage)}` : 'finished'}`); return; }
    if (event.type === 'turn_start' || event.type === 'activity_wait') { this.update(role, 'waiting_for_provider', 'Waiting for provider'); return; }
    if (event.type === 'activity_prepare') { this.update(role, 'preparing', 'Preparing provider session'); return; }
    if (!['tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(String(event.type)) || typeof event.toolCallId !== 'string' || typeof event.toolName !== 'string') return;
    const operations = this.operations[role], now = this.clock(), args = object(event.args) ? event.args : {};
    const target = typeof args.command === 'string' ? args.command : typeof args.path === 'string' ? args.path : typeof args.pattern === 'string' ? args.pattern : '';
    const running = this.running[role];
    const operation = operations.get(event.toolCallId) ?? { ...(running.get(event.toolCallId) ?? { id: event.toolCallId, tool: event.toolName, target: visibleText(target), startedAt: now }), updatedAt: now, failed: false, output: '' };
    operation.updatedAt = now;
    if (event.type !== 'tool_execution_start') operation.output = visibleText(observedOutput(event.type === 'tool_execution_end' ? event.result : event.partialResult, 4000), 4200);
    if (event.type === 'tool_execution_end') { operation.endedAt = now; operation.failed = event.isError === true; running.delete(operation.id); }
    else running.set(operation.id, { id: operation.id, tool: operation.tool, target: operation.target, startedAt: operation.startedAt });
    operations.set(operation.id, operation);
    while (operations.size > 8) { const first = operations.keys().next().value; if (first === undefined) break; operations.delete(first); }
    const active = [...running.values()].at(-1);
    const { tool: _tool, target: _target, command: _command, ...current } = this.roles[role];
    const checking = active && ['bash', 'powershell'].includes(active.tool) && isCheckCommand(active.target);
    this.set(role, { ...current, lastActivityAt: now, state: active ? ['read', 'grep', 'find', 'ls'].includes(active.tool) ? 'inspecting' : checking ? 'checking' : 'executing' : 'waiting_for_provider',
      phase: active ? `${active.tool} ${active.target}`.trim().slice(0, 1000) : 'Waiting for provider after tool',
      ...(active ? { tool: active.tool, ...(['bash', 'powershell'].includes(active.tool) ? { command: active.target || active.tool } : { target: active.target || active.tool }) } : {}) });
  }
  private set(role: Role, activity: RoleActivity): void { this.roles[role] = validate(ActivitySchema, activity); this.emit(); }
  private emit(): void { for (const listener of this.listeners) { try { listener(); } catch { /* A renderer cannot revoke or reclassify durable input. */ } } }
}
/** Honest indeterminate status; silence never becomes an invented failure. */
export function activityLine(activity: RoleActivity, now = Date.now()): string {
  const active = busy.has(activity.state), elapsed = Math.max(0, Math.floor((now - activity.startedAt) / 1000));
  const silence = Math.max(0, Math.floor((now - activity.lastActivityAt) / 1000));
  const spinner = ['◐', '◓', '◑', '◒'][Math.floor(now / 100) % 4] ?? '◐';
  return `${active ? spinner + ' ' : ''}${activity.state.replaceAll('_', ' ')}${active ? ` · ${elapsed}s` : ''} · ${activity.phase}`
    + (active && silence >= 15 ? ` · No new activity for ${silence}s; ${activity.tool ? 'awaiting tool output' : 'awaiting provider'}` : '')
    + (active && silence >= 60 ? ' · Escape interrupts; /diagnostics' : '')
    + (activity.usage?.contextWindow ? ` · Context estimate ${activity.usage.contextUsed ?? 'unknown'}/${activity.usage.contextWindow}` : '')
    + (activity.queueCount ? ` · ${activity.queueCount} saved/queued` : '');
}
