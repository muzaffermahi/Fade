import { matchesKey, type Component, type TUI } from '@earendil-works/pi-tui';
import { wordmark } from './logo.js';
import { c, paintLine, spinnerFrame, wrap } from './theme.js';

const MIN_SHOW_MS = 900;
const TWINKLE_MS = 140;

export class Splash implements Component {
  private ready = false;
  private error: string | undefined;
  private readonly started = Date.now();
  private readonly timer: NodeJS.Timeout;
  private entered = false;
  private quitArmedAt = 0;

  constructor(
    private readonly tui: TUI,
    private readonly onDone: () => void,
    private readonly onQuit: () => void,
  ) {
    this.timer = setInterval(() => {
      this.maybeEnter();
      this.tui.requestRender();
    }, TWINKLE_MS);
  }

  invalidate(): void {}

  dispose(): void {
    clearInterval(this.timer);
  }

  markReady(): void {
    this.ready = true;
    this.maybeEnter();
  }

  fail(message: string): void {
    this.error = message;
    this.tui.requestRender();
  }

  private maybeEnter(): void {
    if (this.entered || !this.ready || Date.now() - this.started < MIN_SHOW_MS) return;
    this.entered = true;
    this.onDone();
  }

  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) {
      const now = Date.now();
      if (this.quitArmedAt && now - this.quitArmedAt <= 1500) return this.onQuit();
      this.quitArmedAt = now;
      this.tui.requestRender();
    } else if (this.ready) {
      this.entered = true;
      this.onDone();
    }
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.tui.terminal.rows - 1);
    const seed = Math.floor((Date.now() - this.started) / TWINKLE_MS);
    const mark = wordmark(width, seed);
    const center = (line: string, visible: number): string =>
      ' '.repeat(Math.max(0, Math.floor((width - visible) / 2))) + line;
    const markWidth = Math.max(...mark.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').length));
    const lines = mark.map((line) => center(line, markWidth));
    const tagline = 'A tool for the mind.';
    lines.push('', center(c.muted(tagline), tagline.length), '');
    if (this.error) {
      for (const line of wrap(this.error, Math.min(width - 4, 70))) lines.push(center(c.rose(line), line.length));
      const hint = 'Fix that, then run fade again. (ctrl+c twice to quit)';
      lines.push('', center(c.muted(hint), hint.length));
    } else {
      const status = this.quitArmedAt ? 'Press Ctrl+C again to quit' : `${spinnerFrame()} warming up…`;
      lines.push(center(c.mint(status), status.length));
    }
    const top = Math.max(0, Math.floor((rows - lines.length) / 2));
    const out = [...Array(top).fill(''), ...lines];
    while (out.length < rows) out.push('');
    return out.slice(0, rows).map((line) => paintLine(line, width));
  }
}
