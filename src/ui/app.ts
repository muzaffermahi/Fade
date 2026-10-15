import {
  CombinedAutocompleteProvider, Editor, matchesKey, ProcessTerminal, TuiMainScreen,
  type Component, type Focusable, type OverlayHandle, type SlashCommand, type TUI,
} from '@earendil-works/pi-tui';
import { Git } from '../git.js';
import type { Fade } from '../loop.js';
import { CompanionRenderer } from './companion-pane.js';
import {
  CardEditorOverlay, ConfirmOverlay, editorTheme, HelpOverlay, InfoOverlay, ReviewOverlay, TextPromptOverlay,
} from './overlays.js';
import { FOCUS_ORDER, renderScreen, type Focus, type ScreenState, type UiMeta } from './screen.js';
import { Splash } from './splash.js';
import { FADE_MS } from './strip.js';

export type { UiMeta } from './screen.js';

const QUIT_WINDOW_MS = 1000;
const TOAST_MS = 2500;
type Pane = 'builder' | 'companion';

/** Commands Fade answers itself, on top of the agent's Pi commands. */
const APP_COMMANDS: SlashCommand[] = [
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  { name: 'quit', description: 'Quit Fade' },
];

export class FadeApp implements Component, Focusable {
  focused = true;
  private state: ScreenState = {
    focus: 'companion', scroll: { builder: 0, companion: 0 }, selected: 0, rawLog: false, fading: [],
    toast: undefined, now: Date.now(),
  };
  private readonly builderEditor: Editor;
  private readonly companionEditor: Editor;
  private readonly renderer = new CompanionRenderer();
  private overlay: OverlayHandle | undefined;
  private quitArmedAt = 0;
  private toastTimer: NodeJS.Timeout | undefined;
  private fadeTimer: NodeJS.Timeout | undefined;
  private readonly ticker: NodeJS.Timeout;

  constructor(
    private readonly tui: TUI, private readonly fade: Fade, private readonly git: Git,
    private readonly meta: UiMeta, private readonly quit: () => void,
  ) {
    this.builderEditor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.companionEditor = new Editor(tui, editorTheme(), { paddingX: 1 });
    this.builderEditor.onSubmit = text => this.send('builder', text);
    this.companionEditor.onSubmit = text => this.send('companion', text);
    this.ticker = setInterval(() => this.tick(), 100);
    this.ticker.unref();
    this.setupAutocomplete();
    this.syncEditorFocus();
  }

  /** Typing "/" lists the commands for that pane's agent. */
  private setupAutocomplete(): void {
    for (const pane of ['builder', 'companion'] as const) {
      const commands = [...APP_COMMANDS, ...(this.fade.slashHost(pane)?.commands() ?? [])];
      const editor = pane === 'builder' ? this.builderEditor : this.companionEditor;
      editor.setAutocompleteProvider(new CombinedAutocompleteProvider(commands, this.meta.cwd));
    }
  }

  dispose(): void {
    clearInterval(this.ticker);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    if (this.fadeTimer) clearInterval(this.fadeTimer);
  }

  invalidate(): void {}

  // ---- rendering ----

  private tick(): void {
    const view = this.fade.view();
    if (view.building || view.companionBusy) this.tui.requestRender();
  }

  render(width: number): string[] {
    this.state.now = Date.now();
    const rows = Math.max(1, this.tui.terminal.rows - 1);
    return renderScreen(this.fade.view(), this.state, {
      builderEditor: this.builderEditor, companionEditor: this.companionEditor, companion: this.renderer,
    }, this.meta, width, rows);
  }

  private syncEditorFocus(): void {
    const open = this.overlay !== undefined;
    this.builderEditor.focused = !open && this.state.focus === 'builder';
    this.companionEditor.focused = !open && this.state.focus === 'companion';
  }

  private refresh(): void {
    this.syncEditorFocus();
    this.tui.requestRender();
  }

  private toast(text: string): void {
    this.state.toast = text;
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => {
      this.state.toast = undefined;
      this.tui.requestRender();
    }, TOAST_MS);
    this.toastTimer.unref();
    this.refresh();
  }

  // ---- input ----

  handleInput(data: string): void {
    if (this.overlay) return; // overlays take their own input
    if (matchesKey(data, 'ctrl+c')) return this.ctrlC();
    this.quitArmedAt = 0;
    const editor = this.editor();
    if (editor?.isShowingAutocomplete()) {
      editor.handleInput(data); // tab, enter, esc and arrows belong to the suggestion list
      return this.tui.requestRender();
    }
    if (matchesKey(data, 'tab')) return this.cycleFocus(1);
    if (matchesKey(data, 'shift+tab')) return this.cycleFocus(-1);
    if (matchesKey(data, 'ctrl+r')) return this.openFirstReview();
    if (matchesKey(data, 'ctrl+l')) {
      this.state.rawLog = !this.state.rawLog;
      return this.refresh();
    }
    if (matchesKey(data, 'f1')) return this.openHelp();
    if (this.state.focus === 'plan') return this.planKey(data);
    this.paneKey(data);
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
    if (data === '?' && editor.getText() === '') return this.openHelp();
    if (matchesKey(data, 'escape')) {
      if (focus === 'builder') {
        void this.fade.stopBuilder();
      } else {
        void this.fade.stopCompanion();
      }
      return;
    }
    const page = Math.max(3, this.tui.terminal.rows - 12);
    if (matchesKey(data, 'pageUp')) this.state.scroll[focus] += page;
    else if (matchesKey(data, 'pageDown')) this.state.scroll[focus] = Math.max(0, this.state.scroll[focus] - page);
    else editor.handleInput(data);
    this.tui.requestRender();
  }

  private send(which: Pane, text: string): void {
    if (!text.trim()) return;
    if (text.trim().startsWith('/')) return void this.slash(which, text.trim());
    this.state.scroll[which] = 0;
    if (which === 'builder') this.fade.sendToBuilder(text);
    else this.fade.sendToCompanion(text);
    this.tui.requestRender();
  }

  private async slash(which: Pane, text: string): Promise<void> {
    const name = text.slice(1).split(' ')[0] ?? '';
    if (name === 'hotkeys' || name === 'help') return this.openHelp();
    if (name === 'quit') return this.quit();
    const host = this.fade.slashHost(which);
    if (!host) return this.toast('Slash commands need a real model; they are off in --demo.');
    this.toast(`/${name}…`);
    const result = await host.run(text);
    if (result.kind === 'prompt') {
      this.state.scroll.companion = 0;
      this.fade.sendToCompanion(text);
    } else if (result.kind === 'info') {
      this.show(new InfoOverlay(this.rows, `/${name}`, result.text, () => this.close()));
    } else {
      if (result.model && which === 'builder') this.meta.builderModel = result.model;
      if (result.model && which === 'companion') this.meta.companionModel = result.model;
      if (result.newSession && which === 'companion') this.fade.clearCompanionChat();
      this.toast(result.text);
    }
    this.setupAutocomplete();
  }

  private planKey(data: string): void {
    const cards = this.fade.view().cards;
    const count = cards.length;
    this.state.selected = Math.max(0, Math.min(count - 1, this.state.selected));
    const card = cards[this.state.selected];
    if (matchesKey(data, 'alt+up') || data === 'K') return this.moveCard(-1);
    if (matchesKey(data, 'alt+down') || data === 'J') return this.moveCard(1);
    if (matchesKey(data, 'up') || data === 'k') this.state.selected = Math.max(0, this.state.selected - 1);
    else if (matchesKey(data, 'down') || data === 'j') this.state.selected = Math.min(count - 1, this.state.selected + 1);
    else if (data === 'n') return this.newCard();
    else if (data === '?') return this.openHelp();
    else if (!card) return;
    else if (matchesKey(data, 'space')) this.fade.toggleReady(card.title);
    else if (matchesKey(data, 'enter')) this.openCard(card.title);
    else if (data === 'x') this.confirmDrop(card.title);
    else if (card.state === 'review' && data === 'a') this.accept(card.title);
    else if (card.state === 'review' && data === 'r') this.askRevise(card.title);
    else if (card.state === 'review' && data === 'u') this.confirmUndo(card.title);
    this.tui.requestRender();
  }

  private moveCard(direction: -1 | 1): void {
    const card = this.fade.view().cards[this.state.selected];
    if (!card) return;
    this.fade.move(card.title, direction);
    this.state.selected += direction;
  }

  // ---- actions ----

  private accept(title: string): void {
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
      this.tui.requestRender();
    }, 50);
    this.fadeTimer.unref();
  }

  // ---- overlays ----

  private show(component: Component): void {
    this.overlay = this.tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' });
    this.syncEditorFocus();
    this.tui.requestRender();
  }

  private close(): void {
    this.overlay?.hide();
    this.overlay = undefined;
    this.tui.setFocus(this);
    this.refresh();
  }

  private rows = (): number => this.tui.terminal.rows;

  private openHelp(): void {
    this.show(new HelpOverlay(this.rows, () => this.close()));
  }

  private openFirstReview(): void {
    const first = this.fade.view().reviews[0];
    if (first) this.openReview(first.title);
    else this.toast('Nothing to review yet');
  }

  private openCard(title: string): void {
    const card = this.fade.view().cards.find(c => c.title === title);
    if (!card) return;
    if (card.state === 'review') return this.openReview(title);
    if (card.state === 'building') return this.toast('The Builder is on this one');
    this.show(new CardEditorOverlay(this.tui, card, (newTitle, body) => {
      this.fade.editCard(title, { title: newTitle, body });
      this.close();
    }, () => this.close()));
  }

  private openReview(title: string): void {
    const view = this.fade.view();
    const review = view.reviews.find(r => r.title === title)
      ?? { title, summary: 'Ready for a look.', howToTry: '', files: [], finishedAt: Date.now() };
    const diff = review.sha ? this.git.show(review.sha) : '';
    this.show(new ReviewOverlay(this.rows, review, diff, {
      accept: () => {
        this.close();
        this.accept(title);
      },
      revise: () => {
        this.close();
        this.askRevise(title);
      },
      undo: () => {
        this.close();
        this.confirmUndo(title);
      },
      close: () => this.close(),
    }));
  }

  private askRevise(title: string): void {
    const stuck = this.fade.view().reviews.find(r => r.title === title)?.question;
    this.show(new TextPromptOverlay(this.tui, stuck ? 'Your answer' : 'What should change?', note => {
      this.close();
      this.fade.revise(title, note);
    }, () => this.close()));
  }

  private confirmUndo(title: string): void {
    this.show(new ConfirmOverlay(this.rows, `Undo "${title}"? Fade will queue a card to revert it.`, () => {
      this.close();
      this.fade.undo(title);
    }, () => this.close()));
  }

  private confirmDrop(title: string): void {
    this.show(new ConfirmOverlay(this.rows, `Drop "${title}"?`, () => {
      this.close();
      this.fade.drop(title);
    }, () => this.close()));
  }

  private newCard(): void {
    this.show(new TextPromptOverlay(this.tui, 'New card title', title => {
      this.close();
      this.show(new CardEditorOverlay(this.tui, { title, body: '' }, (finalTitle, body) => {
        this.fade.addCard(finalTitle, body);
        this.close();
      }, () => this.close()));
    }, () => this.close()));
  }

  setFocus(focus: Focus): void {
    this.state.focus = focus;
    this.refresh();
  }
}

export async function startUi(fade: Fade, meta: UiMeta): Promise<void> {
  const tui = new TuiMainScreen(new ProcessTerminal());
  const git = new Git(meta.cwd);
  let app: FadeApp | undefined;
  const quit = (): void => {
    app?.dispose();
    tui.stop();
    fade.dispose();
    process.exit(0);
  };
  process.on('uncaughtException', error => {
    tui.stop();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

  const enter = (): void => {
    splash.dispose();
    tui.removeChild(splash);
    fade.start();
    app = new FadeApp(tui, fade, git, meta, quit);
    tui.addChild(app);
    tui.setFocus(app);
    fade.onChange(() => tui.requestRender());
    tui.requestRender();
  };
  const splash = new Splash(tui, enter, quit);
  tui.addChild(splash);
  tui.setFocus(splash);
  tui.start();
  fade.init().then(() => splash.markReady(), (error: unknown) => {
    splash.fail(error instanceof Error ? error.message : String(error));
  });
}
