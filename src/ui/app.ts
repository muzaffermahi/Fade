// TEMPORARY Phase 1 screen: a plain single column. Replaced in Phase 2.
import { matchesKey, ProcessTerminal, TuiMainScreen, truncateToWidth, type Component } from '@earendil-works/pi-tui';
import type { Fade } from '../loop.js';

export interface UiMeta {
  cwd: string;
  branch: string;
  builderModel: string;
  companionModel: string;
}

class SimpleScreen implements Component {
  selected = 0;
  constructor(private readonly fade: Fade, private readonly quit: () => void) {}

  invalidate(): void {}

  render(width: number): string[] {
    const view = this.fade.view();
    const lines: string[] = ['FADE (phase 1 screen)  ↑↓ select · space ready · ctrl+c quit', ''];
    view.cards.forEach((card, i) => {
      lines.push(`${i === this.selected ? '›' : ' '} [${card.state}] ${card.title}`);
    });
    for (const done of view.done) lines.push(`  ✓ ${done.title}`);
    lines.push('');
    if (view.building) {
      lines.push(`Building: ${view.building.title}`);
      for (const step of view.building.steps) lines.push(`  ${step.status === 'done' ? '✓' : '·'} ${step.text}`);
      if (view.building.action) lines.push(`  └ ${view.building.action}`);
    } else {
      lines.push('Builder idle');
    }
    if (view.builderError) lines.push(`Error: ${view.builderError}`);
    for (const review of view.reviews) lines.push(`To review: ${review.title} - ${review.summary}`);
    if (view.toast) lines.push(view.toast);
    return lines.map(line => truncateToWidth(line, width, '…'));
  }

  handleInput(data: string): void {
    const count = this.fade.view().cards.length;
    if (matchesKey(data, 'ctrl+c')) this.quit();
    else if (matchesKey(data, 'up')) this.selected = Math.max(0, this.selected - 1);
    else if (matchesKey(data, 'down')) this.selected = Math.min(count - 1, this.selected + 1);
    else if (matchesKey(data, 'space')) {
      const card = this.fade.view().cards[this.selected];
      if (card) this.fade.toggleReady(card.title);
    } else if (data === 'a') {
      const card = this.fade.view().cards[this.selected];
      if (card) this.fade.accept(card.title);
    }
  }
}

export async function startUi(fade: Fade, _meta: UiMeta): Promise<void> {
  await fade.init();
  fade.start();
  const tui = new TuiMainScreen(new ProcessTerminal());
  const screen = new SimpleScreen(fade, () => {
    tui.stop();
    fade.dispose();
    process.exit(0);
  });
  tui.addChild(screen);
  tui.setFocus(screen);
  fade.onChange(() => tui.requestRender());
  tui.start();
}
