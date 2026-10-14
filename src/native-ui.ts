import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { TuiMainScreen, TuiAltScreen, type Component, type TUI } from '@earendil-works/pi-tui';

export function focusedComponent(tui: TUI): Component | null { return tui instanceof TuiMainScreen || tui instanceof TuiAltScreen ? tui.getFocusedComponent() : null; }
export type NativeAction = { command?: string; key?: string; finite: boolean };
export interface NativeHandoff {
  unmount(): void;
  reopen(): void;
  notify(message: string): void;
}
/** Owns public Pi root mounting and finite native-control lifetime on the one TUI. */
export class NativeUIAdapter {
  readonly nativeFocus: Component | null;
  private readonly roots: Component[];
  private readonly cleanup = new Set<() => void>();
  private mounted = false;
  private disposed = false;
  private running = false;
  private prompts = 0;
  private cancelWait: (() => void) | undefined;
  constructor(private readonly tui: TUI) {
    this.roots = [...tui.children]; this.nativeFocus = focusedComponent(tui);
  }
  /** Each resource belongs to this mount and is disposed once on restoration. */
  onUnmount(cleanup: () => void): void { this.cleanup.add(cleanup); }
  mount(component: Component): void {
    if (this.disposed || this.mounted) throw new Error('Fade UI mount is unavailable or already active.');
    this.mounted = true; this.tui.clear(); this.tui.addChild(component); this.tui.setFocus(component); this.tui.requestRender();
  }
  restore(): void {
    if (!this.mounted) return;
    this.mounted = false;
    for (const cleanup of this.cleanup) cleanup(); this.cleanup.clear();
    this.tui.clear(); for (const root of this.roots) this.tui.addChild(root);
    this.tui.setFocus(this.nativeFocus); this.tui.requestRender(true);
  }
  promptStarted(): void { if (this.running) this.prompts++; }
  promptEnded(): void { if (this.running) this.prompts = Math.max(0, this.prompts - 1); }
  /** Public current focus is sufficient to observe native selectors and editor restoration. */
  nativeScreen(): string[] { return focusedComponent(this.tui)?.render(this.tui.terminal.columns) ?? []; }
  async handoff(action: NativeAction, ports: NativeHandoff): Promise<void> {
    if (this.running || this.disposed) throw new Error('A native control is already active or the UI is closed.');
    this.running = true;
    try {
      ports.unmount();
      // ui.custom(done) restores Pi's editor synchronously; allow its promise callbacks to settle.
      await Promise.resolve();
      const editor = focusedComponent(this.tui);
      if (!(editor instanceof CustomEditor) || this.tui.hasOverlay()) throw new Error('Native editor is not ready. Drafts are retained.');
      if (action.command) {
        if (!editor.onSubmit) throw new Error('Native command handler is unavailable.');
        editor.setText('');
        // onSubmit is the public editor callback. Its native async result is awaited at runtime.
        await editor.onSubmit(action.command);
      } else if (action.key) editor.handleInput(action.key);
      if (this.disposed) return;
      if (!action.finite) { ports.notify('Native Pi control active. Use /fade to return to your saved panes.'); return; }
      await this.waitForEditor();
      if (!this.disposed) ports.reopen();
    } catch (error) {
      if (!this.disposed) { ports.reopen(); ports.notify(`Native control failed: ${error instanceof Error ? error.message : String(error)} Use /pi to retry.`); }
    } finally { this.running = false; this.prompts = 0; }
  }
  private waitForEditor(): Promise<void> {
    return new Promise(resolve => {
      let stable = 0;
      const finish = () => { clearInterval(timer); this.cancelWait = undefined; resolve(); };
      const timer = setInterval(() => {
        const ready = !this.tui.hasOverlay() && !this.prompts && focusedComponent(this.tui) instanceof CustomEditor;
        stable = ready ? stable + 1 : 0;
        if (this.disposed || stable >= 2) finish();
      }, 16);
      timer.unref(); this.cancelWait = finish;
    });
  }
  dispose(): void {
    if (this.disposed) return;
    this.restore(); this.disposed = true; this.cancelWait?.();
  }
}
