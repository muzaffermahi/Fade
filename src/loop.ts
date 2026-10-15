import { Engine } from './engine.js';
import { titleFromText } from './view.js';
import type { Card, DoneEntry, SlashHost } from './types.js';

export type { FadeOptions } from './engine.js';
export { titleFromText };

/** Everything you can do: ready steps, review what landed, keep the thread, talk to either agent. */
export class Fade extends Engine {

  toggleReady(title: string): void {
    const card = this.model.find(title);
    if (!card) return;
    if (card.state === 'draft') {
      card.state = 'ready';
      this.builderError = undefined;
      if (this.freshDraft === title) this.freshDraft = undefined;
      this.model.save();
      this.tick();
    } else if (card.state === 'ready') {
      card.state = 'draft';
      this.model.save();
    }
    this.notify();
  }

  move(title: string, direction: -1 | 1): void {
    if (this.model.move(title, direction)) this.persist();
  }

  drop(title: string): void {
    const card = this.model.find(title);
    if (!card || card.state === 'building') return;
    this.model.remove(title);
    this.removeReview(title);
    if (this.freshDraft === title) this.freshDraft = undefined;
    this.persist();
  }

  addCard(title: string, body: string): string {
    const unique = this.model.add(title, body);
    this.persist();
    return unique;
  }

  /** A card the Companion proposed: it becomes the "ready it?" suggestion. */
  proposeCard(title: string, body: string): string {
    const unique = this.model.add(title, body);
    this.freshDraft = unique;
    this.persist();
    return unique;
  }

  editCard(title: string, patch: { title?: string; body?: string }, proposed = false): void {
    const card = this.model.find(title);
    if (!card) return;
    if (patch.body !== undefined) card.body = patch.body.trim();
    const newTitle = patch.title?.trim();
    if (newTitle && newTitle !== card.title) {
      const unique = this.model.unique(newTitle, card);
      const review = this.state.data.reviews.find(r => r.title === card.title);
      if (review) review.title = unique;
      if (this.building?.title === card.title) this.building.title = unique;
      if (this.freshDraft === card.title) this.freshDraft = unique;
      card.title = unique;
    }
    if (proposed && card.state === 'draft') this.freshDraft = card.title;
    this.persist();
  }

  list(): Card[] {
    return this.model.cards.map(card => ({ ...card }));
  }

  setGoal(text: string): void {
    const goal = text.replace(/\s+/g, ' ').trim();
    if (goal === this.model.plan.goal) return;
    this.model.setGoal(goal);
    this.state.data.goalShipped = [];
    this.state.data.goalStartedAt = Date.now();
    this.persist();
  }

  /** Closes a finished goal so the next thread can start. */
  finishGoal(): void {
    this.model.setGoal('');
    this.state.data.goalShipped = [];
    this.state.data.goalStartedAt = Date.now();
    this.persist();
  }

  park(text: string): void {
    this.model.park(text);
    this.persist();
  }

  promote(item: string, title: string, body: string): string {
    this.model.unpark(item);
    return this.proposeCard(title, body);
  }

  accept(title: string): void {
    const card = this.model.find(title);
    if (!card || card.state !== 'review') return;
    const review = this.removeReview(title);
    this.model.remove(title);
    const entry: DoneEntry = review?.sha ? { title, sha: review.sha } : { title };
    this.model.plan.done.push(entry);
    this.state.rollDate();
    this.state.data.shipped.count += 1;
    this.state.data.goalShipped.push(title);
    this.session.shipped.push(title);
    this.persist();
    this.toaster.show('Shipped ✓');
  }

  revise(title: string, note: string): void {
    const card = this.model.find(title);
    if (!card || card.state !== 'review') return;
    this.removeReview(title);
    card.state = 'ready';
    card.body = `${card.body}\n\n> Revise: ${note.trim()}`.trim();
    this.model.moveToTop(card);
    this.model.save();
    this.tick();
    this.persist();
  }

  undo(title: string): void {
    const card = this.model.find(title);
    if (!card || card.state !== 'review') return;
    const review = this.removeReview(title);
    this.model.remove(title);
    const sha = review?.sha ?? 'the checkpoint commit';
    const body = `Revert the changes from commit ${sha} ("fade: ${title}") while keeping later work intact.\n` +
      'Done when: that change is gone and the project still builds and passes its tests.';
    this.model.add(`Undo: ${title}`, body, 'ready', true);
    this.model.save();
    this.tick();
    this.persist();
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
    this.model.add(titleFromText(clean), clean, 'ready', true);
    this.builderError = undefined;
    this.model.save();
    this.tick();
    this.notify();
  }

  async stopBuilder(): Promise<void> {
    if (!this.building) return;
    this.toaster.show('Stopping…');
    await this.builder.stop();
  }

  sendToCompanion(text: string): void {
    // Talking on means you've moved past the step it last proposed (it can propose again).
    this.freshDraft = undefined;
    this.chat.send(text);
  }

  stopCompanion(): Promise<void> {
    return this.chat.stop();
  }

  setBell(on: boolean): void {
    this.state.data.bell = on;
    this.saveState();
    this.notify();
  }

  slashHost(which: 'builder' | 'companion'): SlashHost | undefined {
    return which === 'builder' ? this.builder.slash : this.companion.slash;
  }

  clearCompanionChat(): void {
    this.chat.clear();
  }
}
