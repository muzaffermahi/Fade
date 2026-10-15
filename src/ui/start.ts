import { ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
import { Git } from '../git.js';
import type { Fade } from '../loop.js';
import { FadeApp } from './app.js';
import { recapInput, recapLines } from './recap.js';
import type { UiMeta } from './screen.js';
import { Splash } from './splash.js';


export async function startUi(fade: Fade, meta: UiMeta): Promise<void> {
  const tui = new TuiMainScreen(new ProcessTerminal());
  const git = new Git(meta.cwd);
  let app: FadeApp | undefined;
  const quit = (): void => {
    app?.dispose();
    tui.stop();
    const view = fade.view();
    fade.dispose();
    // Leave the session's recap in the scrollback, ready to screenshot.
    if (view.session.shipped.length > 0) {
      const width = Math.min(72, process.stdout.columns || 72);
      process.stdout.write(`\n${recapLines(recapInput(view, 'Session'), width).join('\n')}\n\n`);
    }
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
    fade.onChange(() => app?.requestRender());
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
