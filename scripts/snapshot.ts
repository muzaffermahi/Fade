// Headless renders of the conversational screen and its surviving overlays.
import { createHarness, type Scenario } from './headless.js';
import { Git } from '../src/git.js';
import { HelpOverlay, ModelPickerOverlay, ShowOverlay } from '../src/ui/overlays.js';
const strip = (line: string): string => line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b_[^\x07]*\x07/g, '');
for (const [width, height] of [[120, 40], [80, 24]] as const) {
  for (const scenario of ['empty', 'building', 'review', 'idle'] as Scenario[]) {
    const h = createHarness(scenario, width, height);
    console.log(`\n=== ${scenario} (${width}×${height}) ===`);
    console.log(h.render().map(strip).join('\n'));
    h.dispose();
  }
}
const h = createHarness('review', 120, 40);
const review = h.fade.view().reviews[0];
const git = new Git(h.cwd);
const noop = (): void => undefined;
const overlays = [new HelpOverlay(() => 40, noop), new ModelPickerOverlay(() => 40, 'Fade', ['demo'], 'demo', noop, noop)];
for (const overlay of overlays) console.log(overlay.render(96).map(strip).join('\n'));
if (review) console.log(new ShowOverlay(() => 40, review, git.numstat(review.sha ?? ''), git.show(review.sha ?? ''), noop).render(96).map(strip).join('\n'));
h.dispose();
