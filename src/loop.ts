import { makeUniqueTitle, type PlanStore } from './plan.js';
import type { StateStore } from './state.js';
import type { Git } from './git.js';
import { formatCompanionContext } from './agents/prompts.js';
import { CompanionChat } from './companion-chat.js';
import { applyBuilderEvent, makeReview, titleFromText, Toast, type BuildingView, type FadeView } from './view.js';
import type {
  BuilderAgent, BuilderEvent, BuildOutcome, Card, CompanionAgent, DoneEntry, Plan, PlanApi, Review, SlashHost,
} from './types.js';

export interface FadeOptions {
  cwd: string;
  plans: PlanStore;
  state: StateStore;
  git: Git;
  builder: BuilderAgent;
  companion: CompanionAgent;
}

export { titleFromText };
const MAX_LOG = 200;

export class Fade implements PlanApi {
  private plan: Plan;
  private building: BuildingView | null = null;
  private lostBuildingCard: Card | undefined;
  private starting = false;
  private disposed = false;
  private builderLog: string[] = [];
  private builderError: string | undefined;
  private readonly toaster = new Toast(() => this.notify());
  private listeners = new Set<() => void>();
  private stopWatching: (() => void) | undefined;
  private readonly plans: PlanStore;
  private readonly state: StateStore;
  private readonly git: Git;
  private readonly builder: BuilderAgent;
  private readonly companion: CompanionAgent;
  private readonly chat: CompanionChat;

  constructor(opts: FadeOptions) {
    this.plans = opts.plans;
    this.state = opts.state;
    this.git = opts.git;
    this.builder = opts.builder;
    this.companion = opts.companion;
    this.chat = new CompanionChat(this.companion, this.state, () => this.notify(), () => formatCompanionContext(this.view()));
    this.state.load();
    this.plan = this.plans.load();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  view(): FadeView {
    this.state.rollDate();
    const view: FadeView = {
      cards: this.plan.cards.map(card => ({ ...card })),
      done: [...this.plan.done],
      reviews: [...this.state.data.reviews],
      building: this.building ? { ...this.building } : null,
      builderLog: [...this.builderLog],
      companion: [...this.state.data.companion],
      companionBusy: this.chat.busy,
      shippedToday: this.state.data.shipped.count,
    };
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
    for (const card of this.plan.cards) if (card.state === 'building') card.state = 'ready';
    const reviewTitles = new Set(this.plan.cards.filter(c => c.state === 'review').map(c => c.title));
    this.state.data.reviews = this.state.data.reviews.filter(r => reviewTitles.has(r.title));
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

  private savePlan(): void {
    try {
      this.plans.save(this.plan);
    } catch (error) {
      this.toaster.show(`Couldn't save PLAN.md: ${messageOf(error)}`);
    }
  }

  private saveState(): void {
    try {
      this.state.save();
    } catch {
      // Losing review/transcript history is not worth interrupting the human.
    }
  }

  private reloadExternal(): void {
    const fresh = this.plans.load();
    const current = this.building;
    if (current) {
      const same = fresh.cards.find(card => card.title === current.title);
      if (same) {
        same.state = 'building';
        this.lostBuildingCard = undefined;
      } else {
        this.lostBuildingCard = this.plan.cards.find(card => card.title === current.title);
      }
    }
    this.plan = fresh;
    const reviewTitles = new Set(fresh.cards.filter(c => c.state === 'review').map(c => c.title));
    this.state.data.reviews = this.state.data.reviews.filter(r => reviewTitles.has(r.title));
    this.tick();
    this.notify();
  }

  private find(title: string): Card | undefined {
    return this.plan.cards.find(card => card.title === title);
  }

  private remove(title: string): Card | undefined {
    const index = this.plan.cards.findIndex(card => card.title === title);
    if (index < 0) return undefined;
    return this.plan.cards.splice(index, 1)[0];
  }

  private removeReview(title: string): Review | undefined {
    const reviews = this.state.data.reviews;
    const index = reviews.findIndex(r => r.title === title);
    if (index < 0) return undefined;
    return reviews.splice(index, 1)[0];
  }

  tick(): void {
    if (this.disposed || this.starting || this.building || this.builder.busy) return;
    const card = this.plan.cards.find(c => c.state === 'ready');
    if (!card) return;
    this.starting = true;
    card.state = 'building';
    this.builderError = undefined;
    this.building = {
      title: card.title, steps: [], action: '', startedAt: Date.now(), liveText: '', lastMessage: '', notes: [],
    };
    this.savePlan();
    this.starting = false;
    this.notify();
    void this.runBuild({ ...card });
  }

  private context(exclude: string): string {
    const next = this.plan.cards.filter(c => c.title !== exclude).slice(0, 3).map(c => `- ${c.title}`);
    if (next.length === 0) return '';
    return `Coming up in the plan (don't work on these):\n${next.join('\n')}`;
  }

  private async runBuild(card: Card): Promise<void> {
    let outcome: BuildOutcome;
    try {
      outcome = await this.builder.build(card, this.context(card.title), e => this.onBuilderEvent(e));
    } catch (error) {
      outcome = { kind: 'failed', error: messageOf(error) };
    }
    this.finishBuild(card, outcome);
  }

  private onBuilderEvent(event: BuilderEvent): void {
    if (event.type === 'log') this.builderLog = [...this.builderLog, event.line].slice(-MAX_LOG);
    else if (this.building) applyBuilderEvent(this.building, event);
    this.notify();
  }

  private checkpoint(message: string): { sha?: string; files: string[] } {
    if (!this.git.hasChanges()) return { files: [] };
    const result = this.git.checkpoint(message);
    if ('error' in result) {
      this.builderError = `Couldn't commit: ${result.error}`;
      return { files: [] };
    }
    return result;
  }

  private takeBuildingCard(card: Card): Card {
    const existing = this.find(card.title);
    if (existing) return existing;
    const restored: Card = this.lostBuildingCard ?? card;
    this.lostBuildingCard = undefined;
    this.plan.cards.unshift(restored);
    return restored;
  }

  private moveToTop(card: Card): void {
    this.remove(card.title);
    this.plan.cards.unshift(card);
  }

  private finishBuild(original: Card, outcome: BuildOutcome): void {
    const card = this.takeBuildingCard(original);
    this.building = null;
    let carryOn = true;
    if (outcome.kind === 'done' || outcome.kind === 'stuck') {
      const partial = outcome.kind === 'stuck' ? ' (partial)' : '';
      const saved = this.checkpoint(`fade: ${card.title}${partial}`);
      card.state = 'review';
      this.removeReview(card.title);
      this.state.data.reviews.push(makeReview(card.title, outcome, saved));
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
    this.savePlan();
    this.saveState();
    if (carryOn) this.tick();
    this.notify();
  }

  private demote(card: Card, note: string): void {
    card.state = 'draft';
    card.body = card.body ? `${card.body}\n\n${note}` : note;
    this.moveToTop(card);
  }

  toggleReady(title: string): void {
    const card = this.find(title);
    if (!card) return;
    if (card.state === 'draft') {
      card.state = 'ready';
      this.builderError = undefined;
      this.savePlan();
      this.tick();
    } else if (card.state === 'ready') {
      card.state = 'draft';
      this.savePlan();
    }
    this.notify();
  }

  move(title: string, direction: -1 | 1): void {
    const index = this.plan.cards.findIndex(card => card.title === title);
    const target = index + direction;
    const cards = this.plan.cards;
    const a = cards[index];
    const b = cards[target];
    if (!a || !b) return;
    cards[index] = b;
    cards[target] = a;
    this.savePlan();
    this.notify();
  }

  drop(title: string): void {
    const card = this.find(title);
    if (!card || card.state === 'building') return;
    this.remove(title);
    this.removeReview(title);
    this.savePlan();
    this.saveState();
    this.notify();
  }

  addCard(title: string, body: string): string {
    const unique = makeUniqueTitle(this.plan.cards, title.trim() || 'Untitled');
    this.plan.cards.push({ title: unique, state: 'draft', body: body.trim() });
    this.savePlan();
    this.notify();
    return unique;
  }

  editCard(title: string, patch: { title?: string; body?: string }): void {
    const card = this.find(title);
    if (!card) return;
    if (patch.body !== undefined) card.body = patch.body.trim();
    const newTitle = patch.title?.trim();
    if (newTitle && newTitle !== card.title) {
      const review = this.state.data.reviews.find(r => r.title === card.title);
      const unique = makeUniqueTitle(this.plan.cards.filter(c => c !== card), newTitle);
      if (review) review.title = unique;
      if (this.building?.title === card.title) this.building.title = unique;
      card.title = unique;
    }
    this.savePlan();
    this.saveState();
    this.notify();
  }

  list(): Card[] {
    return this.plan.cards.map(card => ({ ...card }));
  }

  accept(title: string): void {
    const card = this.find(title);
    if (!card || card.state !== 'review') return;
    const review = this.removeReview(title);
    this.remove(title);
    const entry: DoneEntry = review?.sha ? { title, sha: review.sha } : { title };
    this.plan.done.push(entry);
    this.state.rollDate();
    this.state.data.shipped.count += 1;
    this.savePlan();
    this.saveState();
    this.toaster.show('Shipped ✓');
  }

  revise(title: string, note: string): void {
    const card = this.find(title);
    if (!card || card.state !== 'review') return;
    this.removeReview(title);
    card.state = 'ready';
    card.body = `${card.body}\n\n> Revise: ${note.trim()}`.trim();
    this.moveToTop(card);
    this.savePlan();
    this.saveState();
    this.tick();
    this.notify();
  }

  undo(title: string): void {
    const card = this.find(title);
    if (!card || card.state !== 'review') return;
    const review = this.removeReview(title);
    this.remove(title);
    const sha = review?.sha ?? 'the checkpoint commit';
    const body = `Revert the changes from commit ${sha} ("fade: ${title}") while keeping later work intact. ` +
      'Done when: that change is gone and the project still builds and passes its tests.';
    this.plan.cards.unshift({ title: `Undo: ${title}`, state: 'ready', body });
    this.savePlan();
    this.saveState();
    this.tick();
    this.notify();
  }

  sendToBuilder(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (this.building) {
      this.building.notes.push(clean);
      void this.builder.note(clean).catch(() => undefined);
      this.notify();
      return;
    }
    const title = makeUniqueTitle(this.plan.cards, titleFromText(clean));
    this.plan.cards.unshift({ title, state: 'ready', body: clean });
    this.builderError = undefined;
    this.savePlan();
    this.tick();
    this.notify();
  }

  async stopBuilder(): Promise<void> {
    if (!this.building) return;
    this.toaster.show('Stopping…');
    await this.builder.stop();
  }

  sendToCompanion(text: string): void {
    this.chat.send(text);
  }

  stopCompanion(): Promise<void> {
    return this.chat.stop();
  }

  slashHost(which: 'builder' | 'companion'): SlashHost | undefined {
    return which === 'builder' ? this.builder.slash : this.companion.slash;
  }

  clearCompanionChat(): void {
    this.chat.clear();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
