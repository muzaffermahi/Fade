import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
      let undoProof: string | undefined;
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
        if (i === 2) {
          const undo = card.title.startsWith('Undo:') && /commit ([a-f0-9]+)/.exec(card.body)?.[1];
          if (undo) {
            const files = execFileSync('git', ['show', '--format=', '--name-only', undo], { cwd: this.cwd, encoding: 'utf8' })
              .split('\n').filter(file => /^fade-demo\/[a-z0-9-]+\.txt$/.test(file));
            if (files.length) {
              for (const file of files) {
                let existed = true;
                try { execFileSync('git', ['cat-file', '-e', `${undo}^:${file}`], { cwd: this.cwd, stdio: 'pipe' }); }
                catch { existed = false; }
                if (existed) execFileSync('git', ['restore', `--source=${undo}^`, '--worktree', '--', file], { cwd: this.cwd });
                else rmSync(join(this.cwd, file), { force: true });
              }
              undoProof = `git diff --exit-code "${undo}^" -- ${files.join(' ')}`;
            }
          } else this.writeDemoFile(card);
        }
      }
      if (/stuck/i.test(card.title)) return { kind: 'stuck', question: 'Should this use the old format or the new one?' };
      const text = `Finished "${card.title}".`;
      onEvent({ type: 'message', text });
      const file = `fade-demo/${slug(card.title)}.txt`;
      const checks = doneWhenLines(card.body).map(criterion => ({
        criterion, passed: true, evidence: `checked by reading ${file}`,
        ...(undoProof ? { proof: undoProof } : /friendlier|calmer|reads like/i.test(criterion)
          ? { look: 'Does it feel friendlier?' }
          : /requested demo file|typing "gro"/i.test(criterion)
            ? { proof: `node -e "if (!require('fs').existsSync('${file}')) process.exit(1)"` } : {}),
      }));
      return {
        kind: 'done', summary: text, howToTry: undoProof ? 'The previous demo change is reverted.' : `Open ${file}`,
        tryCommand: undoProof ?? `node -e "process.stdout.write(require('fs').readFileSync('${file}','utf8'))"`,
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

  /** A scripted Fade: queues requests, proposes steps and parks tangents. Enough to feel the flow without a model. */
  async send(text: string, _context: string, onEvent: (e: CompanionEvent) => void): Promise<void> {
    this.running = true;
    this.stopRequested = false;
    try {
      const park = /\b(later|park|by the way|btw)\b/i.test(text);
      const clear = /^(add|make|fix|build|create)\b/i.test(text) && !/friendlier|better|nicer|app\b|tracker\b/i.test(text);
      const look = /friendlier|calmer|styling/i.test(text);
      const second = /the second one/i.test(text);
      const title = second ? 'Friendlier help' : titleFrom(text, 5);
      const reply = park ? 'Parked for later.' : clear || second ? `On it: ${title}.`
        : look ? 'Short and direct, or warm and conversational?'
        : 'I can start with one small step. Want it?';
      const shown = await this.stream(reply, onEvent);
      if (shown) onEvent({ type: 'message', text: shown });
      if (this.stopRequested) return;
      if (park) {
        const idea = titleFrom(text.replace(/\b(later|park|by the way|btw)\b/gi, ''));
        this.plan.park(idea);
        onEvent({ type: 'parked', text: idea });
      } else {
        if (clear || second) {
          const criterion = second ? 'the help feels friendlier.' : 'the requested demo file exists.';
          this.plan.queue(title, `${text}\nDone when: ${criterion}`);
        }
        else if (!look) {
          const card = this.plan.addCard(title, `${text}\nDone when: you can see it working.`);
          onEvent({ type: 'card', title: card, action: 'added' });
        }
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
