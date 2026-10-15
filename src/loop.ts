import { Engine } from './engine.js';
import type { Card, DoneEntry, SlashHost } from './types.js';

export type { FadeOptions } from './engine.js';

export class Fade extends Engine {
  move(title: string, toTop: boolean): void {
    const card = this.model.find(title);
    if (!card || card.state === 'building') return;
    this.model.remove(title);
    if (toTop) this.model.cards.unshift(card);
    else this.model.cards.push(card);
    this.chat.reply(`${title} ${toTop ? 'goes next' : 'will follow the other work'}.`);
    this.persist();
  }

  ready(title: string): void {
    const card = this.model.find(title);
    if (!card || !['draft', 'review'].includes(card.state)) return;
    this.removeReview(title);
    this.chat.reply(`On it: ${title}.`);
    card.state = 'ready';
    this.builderError = undefined;
    this.persist();
    this.tick();
  }

  queue(title: string, body: string): string {
    const unique = this.model.add(title, body, 'ready');
    this.chat.reply(`On it: ${unique}.`);
    this.builderError = undefined;
    this.model.save();
    this.tick();
    this.persist();
    return unique;
  }

  show(title: string): void {
    this.showTitle = title;
    this.chat.reply(`Here’s ${title}.`);
    this.notify();
  }

  clearShow(): void {
    this.showTitle = undefined;
  }

  proposeCard(title: string, body: string): string {
    const unique = this.model.add(title, body);
    this.persist();
    this.chat.reply(`${unique}. Want it?`);
    return unique;
  }

  editCard(title: string, patch: { title?: string; body?: string }): void {
    const card = this.model.find(title);
    if (!card) return;
    if (patch.body !== undefined) card.body = patch.body.trim();
    const newTitle = patch.title?.trim();
    if (newTitle && newTitle !== card.title) {
      const unique = this.model.unique(newTitle, card);
      const review = this.state.data.reviews.find((r) => r.title === card.title);
      if (review) review.title = unique;
      if (this.building?.title === card.title) this.building.title = unique;
      card.title = unique;
    }
    this.chat.reply(`Updated: ${card.title}.`);
    this.persist();
  }

  list(): Card[] {
    return this.model.cards.map((card) => ({ ...card }));
  }

  park(text: string): void {
    this.model.park(text);
    this.chat.reply(`Saved for later: ${text}.`);
    this.persist();
  }

  promote(item: string, title: string, body: string): string {
    this.model.unpark(item);
    return this.proposeCard(title, body);
  }

  accept(title: string, { quiet = false }: { quiet?: boolean } = {}): void {
    const card = this.model.find(title);
    if (!card || card.state !== 'review') return;
    const review = this.removeReview(title);
    this.model.remove(title);
    if (review) this.state.data.landedReviews = [...this.state.data.landedReviews, review].slice(-50);
    const entry: DoneEntry = review?.sha ? { title, sha: review.sha } : { title };
    this.model.plan.done.push(entry);
    this.persist();
    if (!quiet) this.chat.reply(`✓ ${title} — done.`);
  }

  async revise(title: string, body: string, startOver = false): Promise<void> {
    let card = this.model.find(title);
    if (!card) {
      const done = this.model.plan.done.findLast((d) => d.title === title);
      if (!done) return;
      this.model.plan.done = this.model.plan.done.filter((d) => d !== done);
      this.model.add(
        title,
        body + (startOver && done.sha ? `\n\nStart from: revert ${done.sha} first` : ''),
        'ready',
        true,
      );
      this.model.save();
      this.chat.reply(`On it: ${title}.`);
      this.tick();
      this.persist();
      return;
    }
    const wasBuilding = card.state === 'building';
    if (wasBuilding) {
      await this.stopBuilder();
      if (this.disposed) return;
      card = this.model.find(title);
      if (!card) return;
    }
    const review = this.removeReview(title);
    const sha = review?.sha ?? this.checkpoints.get(title);
    card.body = body.trim() + (startOver && sha ? `\n\nStart from: revert ${sha} first` : '');
    card.state = 'ready';
    this.model.moveToTop(card);
    this.model.save();
    this.chat.reply(`On it: ${title}.`);
    this.tick();
    this.persist();
  }

  undo(title: string): void {
    const card = this.model.find(title);
    if (!card) return this.undoDone(title);
    if (card.state !== 'review') return;
    const review = this.removeReview(title);
    this.model.remove(title);
    const sha = review?.sha ?? 'the checkpoint commit';
    this.queueUndo(title, sha);
  }

  /** Queue an intelligent revert for an accepted checkpoint. */
  undoDone(title: string): void {
    const index = this.model.plan.done.findLastIndex((entry) => entry.title === title);
    const entry = this.model.plan.done[index];
    if (!entry?.sha) return;
    this.model.plan.done.splice(index, 1);
    this.queueUndo(title, entry.sha);
  }

  private queueUndo(title: string, sha: string): void {
    this.chat.reply(`↩ Undoing ${title}…`);
    const body =
      `Revert the changes from commit ${sha} ("fade: ${title}") while keeping later work intact.\n` +
      'Include directly preceding partial checkpoints for this same request, preserving unrelated work.\n' +
      'Done when: that change is gone and the project still builds and passes its tests.';
    this.model.add(`Undo: ${title}`, body, 'ready', true);
    this.model.save();
    this.tick();
    this.persist();
  }

  noteBuilder(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    if (!this.building) throw new Error('Nothing is running. Use "continue" to resume paused work.');
    this.chat.reply(`I’ve passed that along for ${this.building.title}.`);
    void this.builder.note(clean).catch(() => undefined);
    this.notify();
  }

  async stopBuilder(): Promise<void> {
    if (!this.building) return;
    this.proofAbort?.abort();
    await this.builder.stop();
    while (this.building && !this.disposed) await new Promise((resolve) => setTimeout(resolve, 10));
  }

  sendToCompanion(text: string): void {
    const clean = text.trim();
    if (!clean) return;
    const word = clean.toLowerCase();
    const drafts = this.model.cards.filter((c) => c.state === 'draft');
    const questions = this.state.data.reviews.filter((r) => r.verdict === 'look' || r.question || word === 'continue');
    const confirm =
      ['yes', 'y', 'go', 'ok'].includes(word) ||
      (word === 'continue' && !this.building && questions.every((r) => !r.question && r.verdict !== 'look'));
    const accepted = this.state.data.landedReviews.filter((review) =>
      this.model.plan.done.some((done) => done.title === review.title && done.sha === review.sha),
    );
    const latest =
      [...this.state.data.reviews, ...accepted].sort((a, b) => a.finishedAt - b.finishedAt).at(-1) ??
      this.model.plan.done.at(-1);
    if (word === 'stop' && this.building) {
      this.state.data.companion.push({ role: 'you', text: clean });
      void this.stopBuilder();
    } else if ((word === 'undo' || word === 'undo that') && latest?.sha) {
      this.state.data.companion.push({ role: 'you', text: clean });
      this.undo(latest.title);
    } else if (confirm && !this.chat.busy && drafts.length + questions.length === 1) {
      const draft = drafts[0];
      const question = questions[0];
      this.state.data.companion.push({ role: 'you', text: clean });
      if (draft) this.ready(draft.title);
      else if (question?.question)
        void this.revise(question.title, `${this.model.find(question.title)?.body ?? ''}\n\nAnswer: yes`);
      else if (question && word === 'continue') this.ready(question.title);
      else if (question) this.accept(question.title);
    } else return this.chat.send(clean);
    this.saveState();
    this.notify();
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
