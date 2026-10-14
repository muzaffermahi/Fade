import { AsyncLocalStorage } from 'node:async_hooks';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { InputReceiptSchema, validate, type InputReceipt } from './contracts.js';

type Destination = Pick<InputReceipt, 'id' | 'sessionId' | 'role' | 'mode'>;
const DestinationSchema = Type.Pick(InputReceiptSchema, ['id', 'sessionId', 'role', 'mode']);
/** Correlate public Pi queue message identity without changing text, images, mode or expansion. */
export class ReceiptCorrelation {
  private readonly scope = new AsyncLocalStorage<Destination>();
  private readonly messages = new WeakMap<object, Destination>();
  private readonly queued = new Set<object>();
  private untracked: boolean;
  private disposed = false;
  private readonly originalSteer: AgentSession['agent']['steer'];
  private readonly originalFollowUp: AgentSession['agent']['followUp'];
  private readonly steer: AgentSession['agent']['steer'];
  private readonly followUp: AgentSession['agent']['followUp'];
  private readonly originalClear: AgentSession['agent']['clearAllQueues'];
  private readonly clear: AgentSession['agent']['clearAllQueues'];
  constructor(private readonly agent: AgentSession['agent']) {
    this.originalSteer = agent.steer; this.originalFollowUp = agent.followUp;
    this.originalClear = agent.clearAllQueues; this.untracked = agent.hasQueuedMessages();
    const remember = (message: Parameters<AgentSession['agent']['steer']>[0]) => {
      const destination = this.scope.getStore();
      if (!this.disposed) this.queued.add(message);
      if (!this.disposed && destination && message.role === 'user') this.messages.set(message, destination);
    };
    this.steer = message => { remember(message); this.originalSteer.call(agent, message); };
    this.followUp = message => { remember(message); this.originalFollowUp.call(agent, message); };
    this.clear = () => { this.queued.clear(); this.untracked = false; this.originalClear.call(agent); };
    agent.steer = this.steer; agent.followUp = this.followUp;
    agent.clearAllQueues = this.clear;
  }
  /** Scope survives asynchronous resource/input hooks and never uses text matching. */
  dispatch<T>(receipt: Destination, operation: () => T): T {
    if (this.disposed) throw new Error('Receipt correlation is disposed; input was not delivered.');
    return this.scope.run(validate(DestinationSchema, { id: receipt.id, sessionId: receipt.sessionId, role: receipt.role, mode: receipt.mode }), operation);
  }
  consumed(message: object): Destination | undefined { this.queued.delete(message); return this.messages.get(message); }
  /** Check parked Fade identity without consuming, clearing or reconstructing any message. */
  hasQueuedOwned(receipts: ReadonlySet<string>): boolean {
    return [...this.queued].some(message => { const receipt = this.messages.get(message); return receipt !== undefined && receipts.has(receipt.id); });
  }
  /** Never clear a third-party queue, even when its text equals our input. */
  allOwned(receipts: ReadonlySet<string>): boolean {
    return !this.untracked && [...this.queued].every(message => { const receipt = this.messages.get(message); return receipt !== undefined && receipts.has(receipt.id); });
  }
  /** Restore only our own public wrappers, preserving other extensions' subsequent changes. */
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    if (this.agent.steer === this.steer) this.agent.steer = this.originalSteer;
    if (this.agent.followUp === this.followUp) this.agent.followUp = this.originalFollowUp;
    if (this.agent.clearAllQueues === this.clear) this.agent.clearAllQueues = this.originalClear;
    this.queued.clear();
    this.scope.disable();
  }
}
