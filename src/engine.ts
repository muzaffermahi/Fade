import { doneWhenLines } from './plan.js';
import { runProofs } from './proof.js';
import { verdict } from './verdict.js';
import type { PlanStore } from './plan.js';
import type { StateStore } from './state.js';
import type { Git } from './git.js';
import { formatCompanionContext } from './agents/prompts.js';
import { CompanionChat } from './companion-chat.js';
import { PlanModel } from './plan-model.js';
import { landingMessage, makeReview, type BuildingView, type FadeView } from './view.js';
import type { BuilderAgent, BuilderEvent, BuildOutcome, Card, CompanionAgent, Review } from './types.js';

export interface FadeOptions {
  cwd: string;
  plans: PlanStore;
  state: StateStore;
  git: Git;
  builder: BuilderAgent;
  companion: CompanionAgent;
}

export abstract class Engine {
  protected checkpoints = new Map<string, string>();
  protected proofAbort: AbortController | undefined;
  protected readonly cwd: string;
  abstract accept(title: string, options?: { quiet?: boolean }): void;

  protected building: BuildingView | null = null;
  protected lostBuildingCard: Card | undefined;
  protected disposed = false;
  protected builderError: string | undefined;
  protected showTitle: string | undefined;
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
    this.cwd = opts.cwd;
    this.plans = opts.plans;
    this.state = opts.state;
    this.git = opts.git;
    this.builder = opts.builder;
    this.companion = opts.companion;
    this.chat = new CompanionChat(
      this.companion,
      this.state,
      () => this.notify(),
      () => formatCompanionContext(this.view()),
    );
    this.state.load();
    this.model = new PlanModel(this.plans, (message) => this.chat.reply(message));
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  protected notify(): void {
    for (const fn of this.listeners) fn();
  }

  get animating(): boolean {
    return this.building !== null || this.chat.busy;
  }

  view(now = Date.now()): FadeView {
    const plan = this.model.plan;
    const data = this.state.data;
    const view: FadeView = {
      cards: plan.cards.map((card) => ({ ...card })),
      later: [...plan.later],
      done: [...plan.done],
      reviews: [...data.reviews],
      landedReviews: [...data.landedReviews],
      building: this.building ? { ...this.building } : null,
      companion: [...data.companion],
      companionBusy: this.chat.busy,
      ...(this.showTitle ? { showTitle: this.showTitle } : {}),
    };
    if (this.builderError) view.builderError = this.builderError;
    if (this.chat.live !== undefined) view.companionLive = this.chat.live;
    return view;
  }

  /** Starts both agents; throws a human-readable error if either can't start. */
  async init(): Promise<void> {
    await Promise.all([this.builder.init(), this.companion.init()]);
  }

  welcome(): void {
    if (this.git.hasChanges()) {
      this.chat.reply('Heads up: you have uncommitted changes. My first checkpoint will include them.');
    }
    if (this.state.data.introduced) return;
    this.chat.reply(`I'll commit each change on ${this.git.branch()} as "fade: …", so anything can be undone.`);
    this.state.data.introduced = true;
    this.saveState();
  }

  start(): void {
    for (const card of this.model.cards) {
      if (card.state !== 'building') continue;
      card.state = 'ready';
      this.chat.reply(`Resuming ${card.title}. Say "stop" to pause it.`);
    }
    this.pruneReviews();
    this.stopWatching = this.plans.watch(() => this.reloadExternal());
    this.tick();
    this.notify();
  }

  dispose(): void {
    this.disposed = true;
    this.proofAbort?.abort();
    this.stopWatching?.();
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
    const reviewTitles = new Set(this.model.cards.filter((c) => c.state === 'review').map((c) => c.title));
    this.state.data.reviews = this.state.data.reviews.filter((r) => reviewTitles.has(r.title));
  }

  protected reloadExternal(): void {
    const current = this.building;
    const fresh = this.plans.load();
    if (current) {
      const same = fresh.cards.find((card) => card.title === current.title);
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
    const index = reviews.findIndex((r) => r.title === title);
    if (index < 0) return undefined;
    return reviews.splice(index, 1)[0];
  }

  tick(): void {
    if (this.disposed || this.building || this.builder.busy) return;
    const card = this.model.cards.find((c) => c.state === 'ready');
    if (!card) return;
    card.state = 'building';
    this.builderError = undefined;
    this.building = {
      title: card.title,
      steps: [],
      action: '',
      startedAt: Date.now(),
    };
    this.model.save();
    this.notify();
    void this.runBuild({ ...card });
  }

  protected context(exclude: string): string {
    const lines: string[] = [];
    const next = this.model.cards
      .filter((c) => c.title !== exclude)
      .slice(0, 3)
      .map((c) => `- ${c.title}`);
    if (next.length > 0) lines.push(`Coming up in the plan (don't work on these):\n${next.join('\n')}`);
    return lines.join('\n\n');
  }

  protected async runBuild(card: Card): Promise<void> {
    let outcome: BuildOutcome;
    try {
      outcome = await this.builder.build(card, this.context(card.title), (e) => this.onBuilderEvent(e));
    } catch (error) {
      outcome = { kind: 'failed', error: messageOf(error) };
    }
    await this.finishBuild(card, outcome);
  }

  protected onBuilderEvent(event: BuilderEvent): void {
    if (this.building && event.type === 'steps') this.building.steps = event.steps;
    if (this.building && event.type === 'action') this.building.action = event.text;
    this.notify();
  }

  protected checkpoint(message: string): { sha?: string; files: string[] } {
    if (!this.git.hasChanges()) return { files: [] };
    const result = this.git.checkpoint(message);
    if ('error' in result) {
      this.builderError = `Couldn't commit: ${result.error} Fix the Git error, then say "continue".`;
      return { files: [] };
    }
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

  protected async finishBuild(original: Card, outcome: BuildOutcome): Promise<void> {
    let card = this.takeBuildingCard(original);
    let quiet = false;
    let carryOn = true;
    if (outcome.kind === 'done' || outcome.kind === 'stuck' || outcome.kind === 'unfinished') {
      const partial = outcome.kind !== 'done' ? ' (partial)' : '';
      const saved = this.checkpoint(`fade: ${card.title}${partial}`);
      if (saved.sha) this.checkpoints.set(card.title, saved.sha);
      const review = makeReview(card, outcome, saved);
      if (outcome.kind === 'done') {
        if (this.building) this.building.action = 'checking…';
        this.notify();
        this.proofAbort = new AbortController();
        review.checks = await runProofs(this.cwd, review.checks ?? [], { ...saved, signal: this.proofAbort.signal });
        const cancelled = this.proofAbort.signal.aborted;
        this.proofAbort = undefined;
        if (cancelled) carryOn = false;
        card = this.takeBuildingCard(original);
        review.verdict = verdict(review.doneWhen ?? [], review.checks);
        // No checkpoint means no sha to undo or to associate with a quiet landing.
        quiet = review.verdict === 'verified' && saved.sha !== undefined && !this.disposed && !cancelled;
        const contradicted = review.checks.filter((check) => check.passed && check.ran && check.ran.code !== 0);
        if (contradicted.length > 0 && !this.state.data.retried.includes(card.title) && !this.disposed && !cancelled) {
          this.state.data.retried.push(card.title);
          card.body +=
            '\n\n> Fade ran the checks:\n' +
            contradicted
              .map((check) => `> ${check.criterion}: \`${check.proof}\` exited ${check.ran?.code}\n${check.ran?.tail}`)
              .join('\n');
          card.state = 'ready';
          this.model.moveToTop(card);
        } else card.state = 'review';
      } else card.state = 'review';
      this.removeReview(card.title);
      if (card.state === 'review') this.state.data.reviews.push(review);
      const checkpointError = this.builderError && !saved.sha ? ` ${this.builderError}` : '';
      this.state.data.companion.push({
        role: 'landed',
        text: landingMessage(review, card.state === 'ready') + checkpointError,
      });
    } else if (outcome.kind === 'stopped') {
      const saved = this.checkpoint(`fade: ${card.title} (partial)`);
      if (saved.sha) this.checkpoints.set(card.title, saved.sha);
      this.demote(card, '> Stopped partway.');
      carryOn = false;
      this.chat.reply(`■ Stopped ${card.title}. Say "continue" or tell me what to change.`);
    } else {
      this.demote(card, `> Failed: ${outcome.error}`);
      this.builderError = outcome.error;
      this.state.data.companion.push({ role: 'landed', text: `✗ ${card.title} couldn't finish: ${outcome.error}` });
      // NOTE: no automatic retry, and no ticking on: a broken setup would fail every ready card in turn.
      // Sending the Builder a task (or readying a card) resumes the queue.
      carryOn = false;
    }
    this.building = null;
    if (quiet) this.accept(card.title, { quiet: true });
    if (carryOn) this.tick();
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
