import { visibleWidth } from '@earendil-works/pi-tui';
import { wordmark } from '../src/workspace-ui.js';
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
for (const width of [116, 96, 76, 74, 64]) {
  const lines = wordmark(width).map(strip);
  const over = lines.some(l => visibleWidth(l) > width || l.includes('…'));
  console.log(`--- width ${width} | overflow/ellipsis: ${over} | maxw ${Math.max(...lines.map(visibleWidth))} ---`);
  for (const l of lines) console.log(l);
}
