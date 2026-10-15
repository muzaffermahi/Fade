import type { PlanStore } from './plan.js';
import type { StateStore } from './state.js';
import type { Git } from './git.js';
import { formatCompanionContext } from './agents/prompts.js';
import { CompanionChat } from './companion-chat.js';
import { runwayMs } from './flow.js';
import { PlanModel } from './plan-model.js';
import { applyBuilderEvent, makeReview, Toast, type BuildingView, type FadeView, type SessionStats } from './view.js';
import type { BuilderAgent, BuilderEvent, BuildOutcome, Card, CompanionAgent, Review } from './types.js';

export interface FadeOptions {
  cwd: string;
  plans: PlanStore;
  state: StateStore;
  git: Git;
  builder: BuilderAgent;
  companion: CompanionAgent;
}

const MAX_LOG = 200;

/**
 * The machine: schedules the topmost ready step, runs the Builder, checkpoints its work, tracks the session,
 * and builds the view. Your actions on top of it live in Fade (loop.ts).
 */
export abstract class Engine {
  protected building: BuildingView | null = null;
  protected lostBuildingCard: Card | undefined;
  protected starting = false;
  protected disposed = false;
  protected builderLog: string[] = [];
  protected builderError: string | undefined;
  protected freshDraft: string | undefined;
  protected readonly session: SessionStats = { startedAt: Date.now(), shipped: [], commits: 0, idleMs: 0 };
  protected idleSince: number | null = null;
  protected readonly toaster = new Toast(() => this.notify());
  protected listeners = new Set<() => void>();
  protected stopWatching: (() => void) | undefined;
  protected readonly plans: PlanStore;
  protected readonly state: StateStore;
  protected readonly git: Git;
  protected readonly builder: BuilderAgent;
  protected readonly companion: CompanionAgent;
  protected readonly chat: CompanionChat;
  readonly model: PlanModel;

  constructor(opts: FadeOptions) {
    this.plans = opts.plans;
    this.state = opts.state;
    this.git = opts.git;
    this.builder = opts.builder;
    this.companion = opts.companion;
    this.chat = new CompanionChat(this.companion, this.state, () => this.notify(), () => formatCompanionContext(this.view()));
    this.state.load();
    this.model = new PlanModel(this.plans, message => this.toaster.show(message));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected notify(): void {
    for (const fn of this.listeners) fn();
  }

  /** True while something on screen moves on its own (a build or a streaming reply). */
  get animating(): boolean {
    return this.building !== null || this.chat.busy;
  }

  view(now = Date.now()): FadeView {
    this.state.rollDate();
    const plan = this.model.plan;
    const data = this.state.data;
    const idleNow = this.idleSince === null ? 0 : now - this.idleSince;
    const view: FadeView = {
      goal: plan.goal,
      cards: plan.cards.map(card => ({ ...card })),
      later: [...plan.later],
      done: [...plan.done],
      reviews: [...data.reviews],
      building: this.building ? { ...this.building } : null,
      builderLog: [...this.builderLog],
      companion: [...data.companion],
      companionBusy: this.chat.busy,
      shippedToday: data.shipped.count,
      progress: { done: data.goalShipped.length, total: data.goalShipped.length + plan.cards.length },
      runwayMs: runwayMs({
        cards: plan.cards, buildingSince: this.building?.startedAt ?? null, durations: data.durations, now,
      }),
      session: { ...this.session, shipped: [...this.session.shipped], idleMs: this.session.idleMs + idleNow },
      bell: data.bell,
    };
    if (plan.goal && plan.cards.length === 0 && data.goalShipped.length > 0) {
      view.goalComplete = { goal: plan.goal, steps: [...data.goalShipped], startedAt: data.goalStartedAt };
    }
    if (this.freshDraft && this.model.find(this.freshDraft)?.state === 'draft') view.freshDraft = this.freshDraft;
    if (this.builderError) view.builderError = this.builderError;
    if (this.chat.live !== undefined) view.companionLive = this.chat.live;
    if (this.toaster.text) view.toast = this.toaster.text;
    return view;
  }

  /** Starts both agents; throws a human-readable error if either can't start. */
  async init(): Promise<void> {
    await Promise.all([this.builder.init(), this.companion.init()]);
  }

  start(): void {
    for (const card of this.model.cards) if (card.state === 'building') card.state = 'ready';
    this.pruneReviews();
    this.stopWatching = this.plans.watch(() => this.reloadExternal());
    this.tick();
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.stopWatching?.();
    this.toaster.dispose();
    this.saveState();
    this.builder.dispose();
    this.companion.dispose();
  }

  protected saveState(): void {
    try {
      this.state.save();
    } catch {
      // Losing review/transcript history is not worth interrupting the human.
    }
  }

  protected persist(): void {
    this.model.save();
    this.saveState();
    this.notify();
  }

  protected pruneReviews(): void {
    const reviewTitles = new Set(this.model.cards.filter(c => c.state === 'review').map(c => c.title));
    this.state.data.reviews = this.state.data.reviews.filter(r => reviewTitles.has(r.title));
  }

  protected reloadExternal(): void {
    const current = this.building;
    const fresh = this.plans.load();
    if (current) {
      const same = fresh.cards.find(card => card.title === current.title);
      if (same) {
        same.state = 'building';
        this.lostBuildingCard = undefined;
      } else {
        this.lostBuildingCard = this.model.find(current.title);
      }
    }
    this.model.plan = fresh;
    this.pruneReviews();
    this.tick();
    this.notify();
  }

  protected removeReview(title: string): Review | undefined {
    const reviews = this.state.data.reviews;
    const index = reviews.findIndex(r => r.title === title);
    if (index < 0) return undefined;
    return reviews.splice(index, 1)[0];
  }

  tick(): void {
    if (this.disposed || this.starting || this.building || this.builder.busy) return;
    const card = this.model.cards.find(c => c.state === 'ready');
    if (!card) return;
    this.starting = true;
    card.state = 'building';
    this.builderError = undefined;
    if (this.idleSince !== null) this.session.idleMs += Date.now() - this.idleSince;
    this.idleSince = null;
    this.building = {
      title: card.title, steps: [], action: '', startedAt: Date.now(), liveText: '', lastMessage: '', notes: [],
    };
    this.model.save();
    this.starting = false;
    this.notify();
    void this.runBuild({ ...card });
  }

  protected context(exclude: string): string {
    const lines: string[] = [];
    if (this.model.plan.goal) lines.push(`The goal this card serves: ${this.model.plan.goal}`);
    const next = this.model.cards.filter(c => c.title !== exclude).slice(0, 3).map(c => `- ${c.title}`);
    if (next.length > 0) lines.push(`Coming up in the plan (don't work on these):\n${next.join('\n')}`);
    return lines.join('\n\n');
  }

  protected async runBuild(card: Card): Promise<void> {
    let outcome: BuildOutcome;
    try {
      outcome = await this.builder.build(card, this.context(card.title), e => this.onBuilderEvent(e));
    } catch (error) {
      outcome = { kind: 'failed', error: messageOf(error) };
    }
    this.finishBuild(card, outcome);
  }

  protected onBuilderEvent(event: BuilderEvent): void {
    if (event.type === 'log') this.builderLog = [...this.builderLog, event.line].slice(-MAX_LOG);
    else if (this.building) applyBuilderEvent(this.building, event);
    this.notify();
  }

  protected checkpoint(message: string): { sha?: string; files: string[] } {
    if (!this.git.hasChanges()) return { files: [] };
    const result = this.git.checkpoint(message);
    if ('error' in result) {
      this.builderError = `Couldn't commit: ${result.error}`;
      return { files: [] };
    }
    this.session.commits += 1;
    return result;
  }

  protected takeBuildingCard(card: Card): Card {
    const existing = this.model.find(card.title);
    if (existing) return existing;
    const restored: Card = this.lostBuildingCard ?? card;
    this.lostBuildingCard = undefined;
    this.model.cards.unshift(restored);
    return restored;
  }

  protected finishBuild(original: Card, outcome: BuildOutcome): void {
    const card = this.takeBuildingCard(original);
    const startedAt = this.building?.startedAt ?? Date.now();
    this.building = null;
    let carryOn = true;
    if (outcome.kind === 'done' || outcome.kind === 'stuck') {
      const partial = outcome.kind === 'stuck' ? ' (partial)' : '';
      const saved = this.checkpoint(`fade: ${card.title}${partial}`);
      card.state = 'review';
      this.removeReview(card.title);
      this.state.data.reviews.push(makeReview(card, outcome, saved));
      if (outcome.kind === 'done') this.state.recordDuration(Date.now() - startedAt);
    } else if (outcome.kind === 'stopped') {
      this.checkpoint(`fade: ${card.title} (partial)`);
      this.demote(card, '> Stopped partway.');
    } else {
      this.demote(card, `> Failed: ${outcome.error}`);
      this.builderError = outcome.error;
      // NOTE: no automatic retry, and no ticking on: a broken setup would fail every ready card in turn.
      // Sending the Builder a task (or readying a card) resumes the queue.
      carryOn = false;
    }
    if (carryOn) this.tick();
    if (!this.building && !this.disposed) this.idleSince = Date.now();
    this.persist();
  }

  protected demote(card: Card, note: string): void {
    card.state = 'draft';
    card.body = card.body ? `${card.body}\n\n${note}` : note;
    this.model.moveToTop(card);
  }
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
