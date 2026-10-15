import { makeUniqueTitle, type PlanStore } from './plan.js';
import type { Card, Plan } from './types.js';

/** The in-memory plan plus every edit you can make to it. Saving and change notification live here too. */
export class PlanModel {
  plan: Plan;

  constructor(
    private readonly store: PlanStore,
    private readonly onSaveError: (message: string) => void,
  ) {
    this.plan = store.load();
  }

  save(): void {
    try {
      this.store.save(this.plan);
    } catch (error) {
      this.onSaveError(`Couldn't save PLAN.md: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  get cards(): Card[] {
    return this.plan.cards;
  }

  find(title: string): Card | undefined {
    return this.plan.cards.find(card => card.title === title);
  }

  remove(title: string): Card | undefined {
    const index = this.plan.cards.findIndex(card => card.title === title);
    if (index < 0) return undefined;
    return this.plan.cards.splice(index, 1)[0];
  }

  moveToTop(card: Card): void {
    this.remove(card.title);
    this.plan.cards.unshift(card);
  }

  unique(title: string, except?: Card): string {
    return makeUniqueTitle(this.plan.cards.filter(card => card !== except), title);
  }

  add(title: string, body: string, state: Card['state'] = 'draft', top = false): string {
    const unique = this.unique(title.trim() || 'Untitled');
    const card: Card = { title: unique, state, body: body.trim() };
    if (top) this.plan.cards.unshift(card);
    else this.plan.cards.push(card);
    return unique;
  }

  park(text: string): void {
    const item = text.replace(/\s+/g, ' ').trim();
    if (item && !this.plan.later.includes(item)) this.plan.later.push(item);
  }

  /** Removes a Later item (exact or case-insensitive match). Returns whether one was found. */
  unpark(item: string): boolean {
    const wanted = item.trim().toLowerCase();
    const index = this.plan.later.findIndex(entry => entry.toLowerCase() === wanted);
    if (index < 0) return false;
    this.plan.later.splice(index, 1);
    return true;
  }
}
