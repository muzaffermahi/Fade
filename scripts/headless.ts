// Headless rendering helpers shared by tests/render.test.ts and scripts/snapshot.ts.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TuiMainScreen, type Terminal } from '@earendil-works/pi-tui';
import { FakeBuilder, FakeCompanion } from '../src/agents/fake.js';
import { assemble } from '../src/assemble.js';
import { createDemoWorkspace } from '../src/demo.js';
import { Git } from '../src/git.js';
import type { Fade } from '../src/loop.js';
import { FadeApp } from '../src/ui/app.js';

export class FakeTerminal implements Terminal {
  kittyProtocolActive = false;
  constructor(
    public columns: number,
    public rows: number,
  ) {}
  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(): void {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

export type Scenario = 'empty' | 'building' | 'review' | 'idle';

export interface Harness {
  app: FadeApp;
  fade: Fade;
  cwd: string;
  render(): string[];
  dispose(): void;
}

function emptyWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fade-empty-'));
  execFileSync('git', ['init', '-q'], { cwd });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd });
  return cwd;
}

/** Builds a real Fade with fake agents in the given state, and a FadeApp on a fake terminal. */
export function createHarness(
  scenario: Scenario,
  width: number,
  height: number,
  onQuit: () => void = () => undefined,
): Harness {
  const cwd = scenario === 'empty' ? emptyWorkspace() : createDemoWorkspace();
  if (scenario === 'idle') {
    writeFileSync(
      join(cwd, 'PLAN.md'),
      '# Plan\n\n## [review] Core notes app\nAdd notes.\n\n## [draft] Tags\nTag notes.\n',
    );
  }
  const fade = assemble(cwd, (plan) => ({
    builder: new FakeBuilder(cwd, { speed: 0.001 }),
    companion: new FakeCompanion(plan),
  }));
  if (scenario === 'building') fade.start();
  const tui = new TuiMainScreen(new FakeTerminal(width, height));
  const app = new FadeApp(tui, fade, new Git(cwd), { cwd, branch: 'main' }, onQuit);
  return {
    app,
    fade,
    cwd,
    render: () => app.render(width),
    dispose: () => {
      app.dispose();
      fade.dispose();
    },
  };
}
