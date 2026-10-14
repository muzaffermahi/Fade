import { NotificationSchema, validate, type FadeNotification, type ProjectState } from './contracts.js';
import { visibleText } from './activity.js';

/** Validate and bound every notification before any surface renders it. */
export function notification(value: FadeNotification): FadeNotification { return validate(NotificationSchema, { ...value, cause: visibleText(value.cause) || 'No cause supplied.' }); }
/** Recovery controls come exclusively from the coordinator, with an exact receipt when needed. */
export function notificationText(value: FadeNotification): string {
  const action = (name: FadeNotification['actions'][number]) => name === 'restart' ? 'repair storage and restart'
    : name === 'edit-draft' ? 'edit the retained draft' : name === 'retry-input' ? value.receiptId ? `/retry-input ${value.receiptId}` : '/inputs to choose a receipt' : `/${name}`;
  return `${value.role} · ${value.kind.replaceAll('_', ' ')} · ${value.operationId}${value.receiptId ? ` · input ${value.receiptId}` : ''}\n${value.cause}`
    + (value.actions.length ? `\nNext: ${value.actions.map(action).join(' · ')}` : '');
}
/** Bounded transient feedback; durable provenance stays in receipts, slices and logs. */
export class NotificationCenter {
  private readonly items: FadeNotification[] = [];
  private readonly listeners = new Set<() => void>();
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  add(value: FadeNotification): void {
    const checked = notification(value);
    const index = this.items.findIndex(item => item.kind === checked.kind && item.operationId === checked.operationId && item.role === checked.role);
    if (index >= 0) this.items.splice(index, 1);
    this.items.push(checked); if (this.items.length > 20) this.items.shift();
    for (const listener of this.listeners) { try { listener(); } catch { /* Durable receipt authority does not depend on the renderer. */ } }
  }
  dismissLocal(role: FadeNotification['role']): void {
    for (let index = this.items.length - 1; index >= 0; index--) {
      const item = this.items[index]; if (item?.role === role && item.operationId === 'local-control') this.items.splice(index, 1);
    }
  }
  /** Resolved/cancelled/retried receipts and superseded blocked work cease demanding attention. */
  visible(role: FadeNotification['role'], sessionId: string, state?: ProjectState): FadeNotification[] {
    return this.items.filter(item => item.role === role && item.sessionId === sessionId).filter(item => {
      const receipt = item.receiptId ? state?.inputs.find(input => input.id === item.receiptId) : undefined;
      if (receipt && item.kind !== 'result' && item.kind !== 'tool_failure' && !['failed', 'interrupted'].includes(receipt.status)
        && item.kind !== 'accepted_not_delivered' && item.kind !== 'storage_failure') return false;
      if (receipt && ['processed', 'cancelled'].includes(receipt.status) && item.kind !== 'result') return false;
      const slice = state?.slices.find(candidate => candidate.id === item.operationId);
      if (slice && ['provider_failure', 'verification_failure', 'tool_failure'].includes(item.kind) && !['running', 'blocked', 'interrupted'].includes(slice.status)) return false;
      return true;
    }).slice(-3);
  }
}
