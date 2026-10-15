// Frame time for a busy screen. Budget: under 8 ms at 120x40 so typing never lags while both agents stream.
import { createHarness } from './headless.js';
for (const [w, r] of [[120, 40], [200, 60], [80, 24]] as const) {
  const h = createHarness('building', w, r);
  for (let i = 0; i < 20; i++) h.render();
  const n = 200, t = performance.now();
  for (let i = 0; i < n; i++) h.render();
  console.log(`${w}x${r}: ${((performance.now() - t) / n).toFixed(2)} ms/frame`);
  h.dispose();
}
process.exit(0);
