import {
  CombinedAutocompleteProvider, Editor, matchesKey, type Component, type Focusable, type OverlayHandle, type TUI,
} from '@earendil-works/pi-tui';
import { piCliPath } from '../agents/pi.js';
import { nextItem, type NextItem } from '../flow.js';
import type { Git } from '../git.js';
import type { Fade } from '../loop.js';
import type { FadeView } from '../view.js';
import { Attention, QUIET_MS, windowTitle } from './attention.js';
import { APP_COMMANDS, runSlash, type CommandHost } from './commands.js';
import { CardActions, handlePlanKey, type PlanKeyHost } from './card-actions.js';
import { CompanionRenderer } from './companion-pane.js';
import { runPi, runTryCommand } from './handoff.js';
import {
  editorTheme, HelpOverlay, RecapOverlay, TextPromptOverlay,
} from './overlays.js';
import { FOCUS_ORDER, renderScreen, type Focus, type ScreenState, type UiMeta } from './screen.js';
import { recapInput } from './recap.js';
import { FADE_MS } from './strip.js';

export type { UiMeta } from './screen.js';


const QUIT_WINDOW_MS = 1000;
const TOAST_MS = 2500;
type Pane = 'builder' | 'companion';

export class FadeApp implements Component, Focusable, CommandHost, PlanKeyHost {
  focused = true;
  private state: ScreenState = {
    focus: 'companion', scroll: { builder: 0, companion: 0 }, selected: 0, rawLog: false, fading: [],
    toast: undefined, now: Date.now(), next: { kind: 'calm' }, nextKey: '⏎',
  };
  private readonly builderEditor: Editor;
  private readonly companionEditor: Editor;
  private readonly renderer = new CompanionRenderer();
  private readonly attention: Attention;
  readonly cards: CardActions;
  private overlay: OverlayHandle | undefined;
  private quitArmedAt = 0;
  private toastTimer: NodeJS.Timeout | undefined;
  private fadeTimer: NodeJS.Timeout | undefined;
  private quietTimer: NodeJS.Timeout | undefined;
  private readonly ticker: NodeJS.Timeout;
  private title = '';
  private closedGoal = '';
  /** While another program owns the terminal, Fade stops drawing. */
  private suspended = false;

  constructor(
    readonly tui: TUI, readonly fade: Fade, git: Git,
    readonly meta: UiMeta, readonly quit: () => void,
  ) {
    this.builderEditor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.companionEditor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.builderEditor.onSubmit = text => this.send('builder', text);
    this.companionEditor.onSubmit = text => this.send('companion', text);
    this.attention = new Attention(item => this.signal(item));
    this.cards = new CardActions(this, git);
    this.ticker = setInterval(() => {
      if (this.fade.animating) this.requestRender();
    }, 100);
    this.ticker.unref();
    this.refreshCommands();
    this.syncEditorFocus();
  }

  /** Typing "/" lists Fade's commands plus that pane's agent commands. */
  refreshCommands(): void {
    for (const pane of ['builder', 'companion'] as const) {
      const commands = [...APP_COMMANDS, ...(this.fade.slashHost(pane)?.commands() ?? [])];
      const editor = pane === 'builder' ? this.builderEditor : this.companionEditor;
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.meta.cwd));
    }
  }

  dispose(): void {
    clearInterval(this.ticker);
    for (const timer of [this.toastTimer, this.quietTimer]) if (timer) clearTimeout(timer);
    if (this.fadeTimer) clearInterval(this.fadeTimer);
  }

  invalidate(): void {}

  requestRender(force = false): void {
    if (!this.suspended) this.tui.requestRender(force);
  }

  // ---- rendering ----

  private editorText(): string {
    return this.editor()?.getText() ?? '';
  }

  private candidate(view: FadeView): NextItem {
    return nextItem({
      cards: view.cards, reviews: view.reviews, building: view.building !== null,
      runwayMs: view.runwayMs, ...(view.freshDraft ? { freshDraft: view.freshDraft } : {}),
    });
  }

  render(width: number): string[] {
    const now = Date.now();
    this.state.now = now;
    const view = this.fade.view(now);
    const quiet = this.attention.quiet(this.editorText().trim() !== '', now);
    this.state.next = this.attention.resolve(this.candidate(view), view, quiet);
    this.state.nextKey = this.editor() && this.editorText() === '' ? '⏎' : 'ctrl+r';
    this.updateTitle(view);
    if (view.goalComplete && view.goalComplete.goal !== this.closedGoal && !quiet && !this.overlay) {
      setImmediate(() => this.openClosure());
    }
    const rows = Math.max(1, this.tui.terminal.rows - 1);
    return renderScreen(view, this.state, {
      builderEditor: this.builderEditor, companionEditor: this.companionEditor, companion: this.renderer,
    }, this.meta, width, rows);
  }

  private updateTitle(view: FadeView): void {
    const folder = this.meta.cwd.split(/[\\/]/).filter(Boolean).pop() ?? 'Fade';
    const title = windowTitle(view, this.state.next, folder);
    if (title === this.title) return;
    this.title = title;
    this.tui.terminal.setTitle(title);
  }

  /** Something new needs you, and you're at a breakpoint: a quiet bell (if on). The title already changed. */
  private signal(item: NextItem): void {
    if (this.fade.view().bell && item.kind !== 'calm') this.tui.terminal.write('\x07');
  }

  private syncEditorFocus(): void {
    const open = this.overlay !== undefined;
    this.builderEditor.focused = !open && this.state.focus === 'builder';
    this.companionEditor.focused = !open && this.state.focus === 'companion';
  }

  private refresh(): void {
    this.syncEditorFocus();
    this.requestRender();
  }

  toast(text: string): void {
    this.state.toast = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.state.toast = undefined;
      this.requestRender();
    }, TOAST_MS);
    this.toastTimer.unref();
    this.refresh();
  }

  // ---- input ----

  handleInput(data: string): void {
    if (this.overlay || this.suspended) return; // overlays take their own input
    this.noteKeystroke();
    if (matchesKey(data, 'ctrl+c')) return this.ctrlC();
    this.quitArmedAt = 0;
    const editor = this.editor();
    if (editor?.isShowingAutocomplete()) {
      editor.handleInput(data); // tab, enter, esc and arrows belong to the suggestion list
      return this.requestRender();
    }
    if (matchesKey(data, 'tab')) return this.cycleFocus(1);
    if (matchesKey(data, 'shift+tab')) return this.cycleFocus(-1);
    if (matchesKey(data, 'ctrl+r')) return this.doNext();
    if (matchesKey(data, 'ctrl+n')) return this.parkThought();
    if (matchesKey(data, 'ctrl+l')) {
      this.state.rawLog = !this.state.rawLog;
      return this.refresh();
    }
    if (matchesKey(data, 'f1')) return this.openHelp();
    if (this.state.focus === 'plan') return handlePlanKey(this, data);
    this.paneKey(data);
  }

  /** Typing holds new things back; once you pause, let them through. */
  private noteKeystroke(): void {
    this.attention.keystroke();
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.requestRender(), QUIET_MS + 50);
    this.quietTimer.unref();
  }

  private editor(): Editor | undefined {
    if (this.state.focus === 'builder') return this.builderEditor;
    return this.state.focus === 'companion' ? this.companionEditor : undefined;
  }

  private ctrlC(): void {
    const editor = this.editor();
    if (editor && editor.getText() !== '') {
      editor.setText('');
      return this.refresh();
    }
    if (Date.now() - this.quitArmedAt < QUIT_WINDOW_MS) return this.quit();
    this.quitArmedAt = Date.now();
    this.toast('Press Ctrl+C again to quit');
  }

  private cycleFocus(step: number): void {
    const index = FOCUS_ORDER.indexOf(this.state.focus);
    this.state.focus = FOCUS_ORDER[(index + step + FOCUS_ORDER.length) % FOCUS_ORDER.length] ?? 'builder';
    this.refresh();
  }

  private paneKey(data: string): void {
    const focus = this.state.focus;
    const editor = this.editor();
    if (!editor || (focus !== 'builder' && focus !== 'companion')) return;
    const empty = editor.getText() === '';
    if (data === '?' && empty) return this.openHelp();
    if (matchesKey(data, 'enter') && empty) return this.doNext();
    if (matchesKey(data, 'escape')) {
      if (focus === 'builder') void this.fade.stopBuilder();
      else void this.fade.stopCompanion();
      return;
    }
    const page = Math.max(3, this.tui.terminal.rows - 12);
    if (matchesKey(data, 'pageUp')) this.state.scroll[focus] += page;
    else if (matchesKey(data, 'pageDown')) this.state.scroll[focus] = Math.max(0, this.state.scroll[focus] - page);
    else editor.handleInput(data);
    this.requestRender();
  }

  private send(which: Pane, text: string): void {
    if (!text.trim()) return;
    if (text.trim().startsWith('/')) return void runSlash(this, which, text.trim());
    this.state.scroll[which] = 0;
    if (which === 'builder') this.fade.sendToBuilder(text);
    else this.fade.sendToCompanion(text);
    this.requestRender();
  }

  /** The one key that matters: act on whatever is next. Pressing it is itself a breakpoint, so resolve fresh. */
  doNext(): void {
    const view = this.fade.view();
    const item = this.attention.resolve(this.candidate(view), view, false);
    this.state.next = item;
    switch (item.kind) {
      case 'stuck':
      case 'review':
        return this.cards.review(item.review.title);
      case 'fresh':
        return this.readyStep(item.title);
      case 'idle':
      case 'low':
        if (item.draft) return this.readyStep(item.draft);
        this.setFocus('companion');
        return this.toast('Tell the Companion what the next step is');
      case 'calm':
        return this.toast(this.fade.view().building ? 'Nothing needs you. Think ahead.' : 'Nothing needs you.');
    }
  }

  private readyStep(title: string): void {
    this.fade.toggleReady(title);
    this.toast(`Ready ✓  ${title}`);
  }

  private parkThought(): void {
    this.show(new TextPromptOverlay(this.tui, 'Park a thought for later', text => {
      this.close();
      this.fade.park(text);
      this.toast('Parked in Later. Back to the thread.');
    }, () => this.close()));
  }

  // ---- actions ----

  accept(title: string): void {
    const index = this.fade.view().cards.findIndex(card => card.title === title);
    this.state.fading.push({ title, start: Date.now(), index });
    this.fade.accept(title);
    this.startFadeTimer();
  }

  private startFadeTimer(): void {
    if (this.fadeTimer) return;
    this.fadeTimer = setInterval(() => {
      const now = Date.now();
      this.state.fading = this.state.fading.filter(entry => now - entry.start < FADE_MS);
      if (this.state.fading.length === 0 && this.fadeTimer) {
        clearInterval(this.fadeTimer);
        this.fadeTimer = undefined;
      }
      this.requestRender();
    }, 50);
    this.fadeTimer.unref();
  }

  /** Lends the terminal to Pi's own screen for `command`, on one agent's session, then takes it back. */
  async handoffPi(command: string, args: string[], reopen: () => Promise<void>, who: string): Promise<void> {
    const cli = piCliPath();
    if (!cli) return this.toast('Pi is not installed alongside Fade; run `npx @earendil-works/pi-coding-agent`.');
    await this.lendTerminal(async () => {
      await runPi(cli, args, this.meta.cwd, `opened Pi on the ${who}'s session. Type /${command} there, then /quit to come back.`);
      await reopen().catch(() => undefined);
    });
    this.refreshCommands();
    this.toast(`Back from Pi /${command}`);
  }

  tryIt(title: string): void {
    const review = this.fade.view().reviews.find(r => r.title === title);
    const command = review?.tryCommand;
    if (!command) return this.toast(review?.howToTry ? `Try it: ${review.howToTry}` : 'No try command for this step.');
    void this.lendTerminal(() => runTryCommand(command, this.meta.cwd).then(() => undefined));
  }

  private async lendTerminal(work: () => Promise<void>): Promise<void> {
    this.close();
    this.suspended = true;
    this.tui.stop();
    try {
      await work();
    } finally {
      this.suspended = false;
      this.tui.start();
      this.tui.setFocus(this);
      this.requestRender(true);
    }
  }

  // ---- overlays ----

  show(component: Component): void {
    this.overlay = this.tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' });
    this.syncEditorFocus();
    this.requestRender();
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.hide();
    this.overlay = undefined;
    this.tui.setFocus(this);
    this.refresh();
  }

  rows = (): number => this.tui.terminal.rows;

  openHelp(): void {
    this.show(new HelpOverlay(this.rows, () => this.close()));
  }

  openFirstReview(): void {
    const first = this.fade.view().reviews[0];
    if (first) this.cards.review(first.title);
    else this.toast('Nothing to review yet');
  }

  openRecap(): void {
    const view = this.fade.view();
    this.show(new RecapOverlay(this.rows, recapInput(view, 'This session'), '⏎ or esc closes', () => this.close(), () => this.close()));
  }

  /** The goal is done: a moment of closure, then a clean start on the next thread. */
  private openClosure(): void {
    const done = this.fade.view().goalComplete;
    if (!done || this.overlay || done.goal === this.closedGoal) return;
    this.closedGoal = done.goal;
    const input = { title: 'Goal complete', goal: done.goal, shipped: done.steps, startedAt: done.startedAt };
    this.show(new RecapOverlay(this.rows, input, '⏎ start the next goal · esc keep looking', () => {
      this.close();
      this.fade.finishGoal();
      this.setFocus('companion');
      this.toast('What is the next goal?');
    }, () => this.close()));
  }

  get selected(): number {
    return this.state.selected;
  }

  set selected(index: number) {
    this.state.selected = index;
  }

  setFocus(focus: Focus): void {
    this.state.focus = focus;
    this.refresh();
  }
}
