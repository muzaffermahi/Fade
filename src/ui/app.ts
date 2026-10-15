import {
  CombinedAutocompleteProvider,
  Editor,
  matchesKey,
  type Component,
  type Focusable,
  type OverlayHandle,
  type TUI,
} from '@earendil-works/pi-tui';
import type { Git } from '../git.js';
import type { Fade } from '../loop.js';
import { APP_COMMANDS, runSlash, type CommandHost } from './commands.js';
import { CompanionRenderer } from './companion-pane.js';
import { editorTheme, HelpOverlay, ShowOverlay } from './overlays.js';
import { renderScreen, type ScreenState, type UiMeta } from './screen.js';
import { sanitize } from './theme.js';
export type { UiMeta } from './screen.js';

export class FadeApp implements Component, Focusable, CommandHost {
  focused = true;
  private state: ScreenState = { scroll: 0, toast: undefined, now: Date.now() };
  private readonly editor: Editor;
  private readonly renderer = new CompanionRenderer();
  private overlay: OverlayHandle | undefined;
  private toastTimer: NodeJS.Timeout | undefined;
  private readonly ticker: NodeJS.Timeout;
  private previousReviews = new Set<string>();
  private title = '';
  private quitArmedAt = 0;
  private lastActivityAt = Date.now();

  constructor(
    readonly tui: TUI,
    readonly fade: Fade,
    private readonly git: Git,
    readonly meta: UiMeta,
    readonly quit: () => void,
  ) {
    this.editor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.editor.focused = true;
    this.editor.onSubmit = (text) => {
      if (!text.trim()) return;
      this.editor.setText('');
      this.state.scroll = 0;
      if (text.trim().startsWith('/')) void runSlash(this, text.trim());
      else this.fade.sendToCompanion(text);
      this.requestRender();
    };
    this.previousReviews = new Set(fade.view().reviews.map((r) => r.title));
    this.ticker = setInterval(() => {
      if (fade.animating) {
        this.lastActivityAt = Date.now();
        this.state.idle = false;
        this.requestRender();
      } else if (!this.state.idle && Date.now() - this.lastActivityAt >= 60_000) {
        this.state.idle = true;
        this.requestRender();
      }
    }, 100);
    this.ticker.unref();
    this.refreshCommands();
  }
  refreshCommands(): void {
    const commands = [...APP_COMMANDS, ...(this.fade.slashHost('companion')?.commands() ?? [])];
    this.editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.meta.cwd));
  }
  dispose(): void {
    clearInterval(this.ticker);
    if (this.toastTimer) clearTimeout(this.toastTimer);
  }
  invalidate(): void {}
  requestRender(force = false): void {
    this.tui.requestRender(force);
  }
  render(width: number): string[] {
    this.state.now = Date.now();
    const view = this.fade.view(this.state.now);
    const reviews = new Set(view.reviews.map((r) => r.title));
    if ([...reviews].some((title) => !this.previousReviews.has(title))) this.tui.terminal.write('\x07');
    this.previousReviews = reviews;
    const title = view.reviews.length
      ? 'Fade · ◆ needs you'
      : view.building
        ? `Fade · ${sanitize(view.building.title)}`
        : 'Fade';
    if (title !== this.title) {
      this.title = title;
      this.tui.terminal.setTitle(title);
    }
    if (view.showTitle) {
      this.fade.clearShow();
      setImmediate(() => this.openShow(view.showTitle));
    }
    return renderScreen(
      view,
      this.state,
      { editor: this.editor, companion: this.renderer },
      this.meta,
      width,
      this.tui.terminal.rows - 1,
    );
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+c')) return this.ctrlC();
    this.quitArmedAt = 0;
    this.lastActivityAt = Date.now();
    this.state.idle = false;
    if (this.overlay) return;
    if (data === '?' && this.editor.getText() === '') return this.openHelp();
    if (matchesKey(data, 'escape')) {
      void this.fade.stopCompanion();
      return;
    }
    const page = Math.max(3, this.tui.terminal.rows - 8);
    if (matchesKey(data, 'pageUp')) this.state.scroll += page;
    else if (matchesKey(data, 'pageDown')) this.state.scroll = Math.max(0, this.state.scroll - page);
    else if (!matchesKey(data, 'tab') && !matchesKey(data, 'shift+tab')) this.editor.handleInput(data);
    this.requestRender();
  }
  /** Global input listener uses this too, so open overlays cannot bypass the warning. */
  ctrlC(): void {
    const now = Date.now();
    if (this.quitArmedAt && now - this.quitArmedAt <= 1500) return this.quit();
    this.quitArmedAt = now;
    if (this.overlay) this.close();
    if (this.editor.getText()) this.editor.setText('');
    this.toast('Input cleared. Press Ctrl+C again to quit.');
  }

  toast(text: string): void {
    this.state.toast = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.state.toast = undefined;
      this.requestRender();
    }, 2500);
    this.toastTimer.unref();
    this.requestRender();
  }
  show(component: Component): void {
    this.close();
    this.overlay = this.tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' });
    this.editor.focused = false;
    this.requestRender();
  }
  close(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.editor.focused = true;
    this.tui.setFocus(this);
    this.requestRender();
  }
  rows = (): number => this.tui.terminal.rows;
  openHelp(): void {
    this.show(new HelpOverlay(this.rows, () => this.close()));
  }
  openShow(title?: string): void {
    const view = this.fade.view();
    const review = title ? view.reviews.find((r) => r.title === title) : view.reviews[0];
    const done = title ? view.done.findLast((d) => d.title === title) : view.done.at(-1);
    const archived = view.landedReviews.findLast((r) => r.title === done?.title);
    const record =
      review ??
      archived ??
      (done
        ? {
            title: done.title,
            verdict: 'none' as const,
            summary: 'Accepted work.',
            howToTry: '',
            files: [],
            finishedAt: 0,
            ...(done.sha ? { sha: done.sha } : {}),
          }
        : undefined);
    if (!record) return this.toast('Nothing built to show yet.');
    this.show(
      new ShowOverlay(
        this.rows,
        record,
        record.sha ? this.git.numstat(record.sha) : [],
        record.sha ? this.git.show(record.sha) : '',
        () => this.close(),
      ),
    );
  }
}
