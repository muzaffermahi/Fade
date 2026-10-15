import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { doneWhenLines } from '../plan.js';
import type {
  BuilderAgent, BuilderEvent, BuildOutcome, Card, CompanionAgent, CompanionEvent, PlanApi, Step,
} from '../types.js';

/** speed multiplies time: 1 is the demo pace, large numbers make tests instant. */
export interface FakeOptions {
  speed?: number;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'card';
}

export class FakeBuilder implements BuilderAgent {
  private running = false;
  private stopRequested = false;
  private wake: (() => void) | undefined;
  private readonly speed: number;

  constructor(private readonly cwd: string, opts: FakeOptions = {}) {
    this.speed = opts.speed ?? 1;
  }

  get busy(): boolean {
    return this.running;
  }

  async init(): Promise<void> {}

  private pause(ms: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(resolve, Math.max(0, ms / this.speed));
      timer.unref();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  async build(card: Card, _context: string, onEvent: (e: BuilderEvent) => void): Promise<BuildOutcome> {
    this.running = true;
    this.stopRequested = false;
    try {
      const labels = ['Read the project', 'Sketch the change', `Build ${card.title}`, 'Run the checks'];
      const actions = ['reading README.md', 'searching', `editing fade-demo/${slug(card.title)}.txt`, 'running npm test'];
      for (let i = 0; i < labels.length; i++) {
        const steps: Step[] = labels.map((text, j) => ({
          text, status: j < i ? 'done' : j === i ? 'active' : 'todo',
        }));
        onEvent({ type: 'steps', steps });
        onEvent({ type: 'action', text: actions[i] ?? '' });
        onEvent({ type: 'log', line: actions[i] ?? '' });
        await this.pause(1500);
        if (this.stopRequested) return { kind: 'stopped' };
        if (i === 2) this.writeDemoFile(card);
      }
      if (/stuck/i.test(card.title)) return { kind: 'stuck', question: 'Should this use the old format or the new one?' };
      const text = `Finished "${card.title}".`;
      onEvent({ type: 'message', text });
      const file = `fade-demo/${slug(card.title)}.txt`;
      const checks = doneWhenLines(card.body).map(criterion => ({
        criterion, passed: true, evidence: `checked by reading ${file}`,
      }));
      return {
        kind: 'done', summary: text, howToTry: `Open ${file}`,
        tryCommand: `node -e "process.stdout.write(require('fs').readFileSync('${file}','utf8'))"`,
        ...(checks.length > 0 ? { checks } : {}),
      };
    } finally {
      this.running = false;
    }
  }

  private writeDemoFile(card: Card): void {
    const dir = join(this.cwd, 'fade-demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slug(card.title)}.txt`), `${card.title}\n\n${card.body}\n`);
  }

  async note(): Promise<void> {}

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.wake?.();
  }

  dispose(): void {
    this.stopRequested = true;
    this.wake?.();
  }
}

const REPLY = 'Good instinct. I would keep it small and start with the part you will touch most, ' +
  'then see how it feels. Want me to turn that into a card?';
const GOAL_REPLY = 'Got it, that is our goal. The smallest useful first step is below: ready it with Enter ' +
  'and I will line up the next one while the Builder works.';
const STEP_REPLY = 'Here is the next step. Small enough to check in a glance. Enter on an empty line readies it.';
const PARK_REPLY = 'Parked that in Later so it does not pull us off the goal. Back to the thread.';

export class FakeCompanion implements CompanionAgent {
  private running = false;
  private stopRequested = false;
  private readonly speed: number;

  constructor(private readonly plan: PlanApi, opts: FakeOptions = {}) {
    this.speed = opts.speed ?? 1;
  }

  get busy(): boolean {
    return this.running;
  }

  async init(): Promise<void> {}

  /** A scripted Companion: names a goal, proposes steps, parks tangents. Enough to feel the flow without a model. */
  async send(text: string, _context: string, onEvent: (e: CompanionEvent) => void): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    try {
      const wantsGoal = !this.plan.goal();
      const wantsPark = /\b(later|park|by the way|btw)\b/i.test(text);
      const wantsStep = wantsGoal || /\b(card|step|next|suggest)\b/i.test(text);
      const reply = wantsPark ? PARK_REPLY : wantsGoal ? GOAL_REPLY : wantsStep ? STEP_REPLY : REPLY;
      const shown = await this.stream(reply, onEvent);
      if (shown) onEvent({ type: 'message', text: shown });
      if (this.stopRequested) return;
      if (wantsPark) {
        const idea = titleFrom(text.replace(/\b(later|park|by the way|btw)\b/gi, ''));
        this.plan.park(idea);
        onEvent({ type: 'parked', text: idea });
      } else if (wantsGoal) {
        const goal = titleFrom(text, 8);
        this.plan.setGoal(goal);
        onEvent({ type: 'goal', text: goal });
      }
      if (wantsStep && !wantsPark) {
        const step = this.nextStepTitle();
        const title = this.plan.addCard(step, `${step} for the goal.\nDone when: you can see it working.`);
        onEvent({ type: 'card', title, action: 'added' });
      }
    } finally {
      this.running = false;
    }
  }

  private async stream(reply: string, onEvent: (e: CompanionEvent) => void): Promise<string> {
    let shown = '';
    for (const word of reply.split(' ')) {
      if (this.stopRequested) break;
      shown = shown ? `${shown} ${word}` : word;
      onEvent({ type: 'text', text: shown });
      await new Promise(resolve => setTimeout(resolve, 30 / this.speed));
    }
    return shown;
  }

  private steps = 0;

  private nextStepTitle(): string {
    const ideas = ['Sketch the data shape', 'Wire up the first screen', 'Handle the empty state', 'Polish the details'];
    const idea = ideas[this.steps % ideas.length] ?? 'Next step';
    this.steps += 1;
    return idea;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
  }

  dispose(): void {
    this.stopRequested = true;
  }
}

function titleFrom(text: string, maxWords = 4): string {
  const words = text.replace(/\bcards?\b/gi, '').split(/\s+/).filter(Boolean).slice(0, maxWords);
  return words.length > 0 ? words.join(' ') : 'New idea';
}
