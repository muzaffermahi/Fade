// Prints headless renders of the key states as plain text. This is how we SEE the UI.
import { createHarness, type Scenario } from './headless.js';

const strip = (line: string): string =>
  line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b_[^\x07]*\x07/g, '');

function show(title: string, scenario: Scenario, width: number, height: number, setup?: (h: ReturnType<typeof createHarness>) => void): void {
  const harness = createHarness(scenario, width, height);
  setup?.(harness);
  const lines = harness.render().map(strip);
  console.log(`\n=== ${title} (${width}x${height}) ===`);
  console.log(lines.map(line => `|${line}|`).join('\n'));
  harness.dispose();
}

const sizes: [number, number][] = [[120, 40], [80, 24]];
for (const [width, height] of sizes) {
  show('empty', 'empty', width, height);
  show('building', 'building', width, height, h => h.app.setFocus('builder'));
  show('review waiting', 'review', width, height);
  show('idle, nothing ready', 'idle', width, height);
  show('plan focused', 'review', width, height, h => h.app.setFocus('plan'));
}
show('too small', 'empty', 50, 12);

import { Git } from '../src/git.js';
import { ConfirmOverlay, HelpOverlay, ReviewOverlay } from '../src/ui/overlays.js';

function showOverlay(title: string, lines: string[]): void {
  console.log(`\n=== overlay: ${title} ===`);
  console.log(lines.map(line => `|${strip(line)}|`).join('\n'));
}

const demo = createHarness('review', 120, 40);
const review = demo.fade.view().reviews[0]!;
const rows = (): number => 40;
const noop = (): void => undefined;
const actions = { accept: noop, revise: noop, undo: noop, close: noop };
showOverlay('review', new ReviewOverlay(rows, review, new Git(demo.cwd).show(review.sha ?? ''), actions).render(96));
showOverlay('review (stuck)', new ReviewOverlay(rows, { ...review, question: 'Old format or new?', summary: 'Needs your answer.' }, '', actions).render(70));
showOverlay('help', new HelpOverlay(rows, noop).render(80));
showOverlay('confirm', new ConfirmOverlay(rows, 'Drop "Tags"?', noop, noop).render(50));
demo.dispose();
process.exit(0);
