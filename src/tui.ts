import {
  InteractiveMode, SessionManager, SettingsManager, createAgentSessionRuntime,
  createAgentSessionServices, createAgentSessionFromServices, getAgentDir, getMarkdownTheme,
  UserMessageComponent, CustomEditor, type ExtensionAPI, type ExtensionFactory, type ExtensionUIContext,
  type CreateAgentSessionServicesOptions,
} from '@mariozechner/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@mariozechner/pi-tui';
import { FadeApp, type AgentFactory } from './app.js';
import { errorText, type Notice } from './coordinator.js';
import { Store } from './store.js';
import { resolvePiModel, type PiOptions } from './pi.js';

const HELP = `Write any ordinary prompt to think with the Companion while the Builder implements the present.

/status · /intent · /pause · /stop · /continue · /redirect <new direction>
/apply-intent · /rethink · /history · /log · /preference design|technical

Pi's editor, multiline input, Markdown, themes, /settings, /model, and /login are available.
/model changes Fade's model (an explicit Builder override stays separate). Escape interrupts Fade. /quit saves and exits.
Projects resume from the current workspace; /continue restarts a recovered Builder.`;

/** Embeds Fade in Pi's stock InteractiveMode; the UI session never runs a model loop. */
export async function createFadeRuntime(store: Store, options: PiOptions = {}, factory?: AgentFactory,
  injected: Pick<CreateAgentSessionServicesOptions, 'authStorage' | 'modelRegistry' | 'settingsManager'> = {}) {
  let api: ExtensionAPI | undefined;
  let ui: ExtensionUIContext | undefined;
  const builderFollowsSelection = !options.builderModel;
  const send = (type: string, text: string) => api?.sendMessage({ customType: type, content: text, display: true }, { triggerTurn: false });
  const show = (notice: Notice) => {
    if (notice.role === 'builder') {
      const status = notice.text.startsWith('Pi is using ')
        ? `Builder · ${notice.text.slice('Pi is using '.length)}`
        : /^(completed|blocked|interrupted):/.test(notice.text)
          ? `Builder ${notice.text.split(':')[0]}` : notice.text;
      ui?.setStatus('fade-builder', status);
      if (!/^(completed|blocked|interrupted):/.test(notice.text)) return;
    }
    send(notice.role === 'companion' ? 'fade-companion' : 'fade-note', notice.text.replaceAll('/resume', '/continue'));
  };
  const app = new FadeApp(store, options, show, value => ui?.setStatus('fade-companion', value), factory);
  options.approve ??= async (command, signal) => ui ? ui.confirm('Fade · Builder command', command, signal ? { signal } : {}) : false;
  const extension: ExtensionFactory = pi => {
    api = pi;
    pi.registerMessageRenderer('fade-human', message => new UserMessageComponent(String(message.content)));
    for (const type of ['fade-companion', 'fade-note']) {
      pi.registerMessageRenderer(type, (message, _options, theme) => {
        const component = new Container();
        component.addChild(new Spacer(1));
        if (type === 'fade-note') component.addChild(new Text(theme.fg('dim', 'Fade'), 1, 0));
        component.addChild(new Markdown(String(message.content), 1, 0, getMarkdownTheme()));
        return component;
      });
    }
    pi.on('session_start', (_event, ctx) => {
      ui = ctx.hasUI ? ctx.ui : undefined;
      ctx.ui.setHeader((_tui, theme) => new Text(
        `${theme.bold(theme.fg('accent', 'Fade'))}\n${theme.fg('dim', 'A tool for the mind. Think about the future while the Builder builds the present.')}\n${theme.fg('dim', '/help · /intent · /pause · /continue · /quit')}`, 1, 1));
      ctx.ui.setStatus('fade-companion', 'Companion ready');
      ctx.ui.setStatus('fade-builder', app.coordinator ? 'Builder paused · /continue' : 'Builder ready');
      ctx.ui.setEditorComponent((tui, theme, keybindings) => {
        const editor = new class extends CustomEditor {
          override handleInput(data: string): void {
            if (keybindings.matches(data, 'app.interrupt') && !this.isShowingAutocomplete() && app.busy) {
              void app.interrupt().catch(error => ctx.ui.notify(errorText(error), 'error'));
              return;
            }
            super.handleInput(data);
          }
        }(tui, theme, keybindings);
        for (const message of app.history()) if (message.role === 'human') editor.addToHistory(message.text);
        return editor;
      });
    });
    pi.on('input', (event, ctx) => {
      // Always consume, including failure: Pi must never fall through into its coding loop.
      try {
        if (event.images?.length) throw new Error('Fade currently accepts text. Your draft remains in the editor.');
        if (event.text.startsWith('/')) throw new Error('Unknown Fade command. /help lists the controls.');
        options.companionThinkingLevel = pi.getThinkingLevel();
        send('fade-human', event.text);
        void app.submit(event.text).catch(error => ctx.ui.notify(errorText(error), 'error'));
      } catch (error) { ctx.ui.setEditorText(event.text); ctx.ui.notify(errorText(error), 'error'); }
      return { action: 'handled' };
    });
    pi.on('model_select', event => {
      options.companionModel = `${event.model.provider}/${event.model.id}`;
      if (builderFollowsSelection) options.builderModel = options.companionModel;
    });
    pi.on('thinking_level_select', event => { options.companionThinkingLevel = event.level; });
    pi.on('user_bash', () => ({ result: {
      output: 'Write an ordinary prompt to Fade. Builder commands run through its execution gate.',
      exitCode: 1, cancelled: false, truncated: false,
    } }));
    const keepProject = () => {
      ui?.notify('Fade history belongs to this workspace. Start Fade in another directory for another project.', 'info');
      return { cancel: true };
    };
    pi.on('session_before_switch', keepProject);
    pi.on('session_before_fork', keepProject);
    pi.on('session_before_tree', keepProject);
    pi.on('session_before_compact', () => ({ cancel: true }));
    pi.on('session_shutdown', async event => { if (event.reason === 'quit') await app.close(); });
    pi.registerCommand('help', { description: 'Fade controls', handler: async () => { send('fade-note', HELP); } });
    for (const name of ['status', 'intent', 'apply-intent', 'rethink', 'pause', 'stop', 'continue', 'redirect', 'history', 'log', 'preference']) {
      pi.registerCommand(name, { description: `Fade ${name}`, handler: async (args, ctx) => {
        try { await app.command(name, args.trim()); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
      } });
    }
  };
  // Durable conversation is owned by Fade; this is only Pi's display history.
  const manager = SessionManager.inMemory(store.workspace);
  manager.appendSessionInfo('Fade');
  for (const message of app.history()) manager.appendCustomMessageEntry(
    message.role === 'human' ? 'fade-human' : 'fade-companion', message.text, true);
  manager.appendCustomMessageEntry('fade-note', app.coordinator
    ? 'Recovered your project, paused. Keep thinking, or /continue to restart implementation.'
    : 'What do you want to create? Your first prompt starts Fade automatically.', true);
  const persistedSettings = SettingsManager.create(store.workspace, getAgentDir());
  const settings = injected.settingsManager ?? SettingsManager.inMemory({
    ...persistedSettings.getGlobalSettings(), ...persistedSettings.getProjectSettings(),
    packages: [], extensions: [], skills: [], prompts: [], quietStartup: true, compaction: { enabled: false },
  });
  try {
    const runtime = await createAgentSessionRuntime(async target => {
      const services = await createAgentSessionServices({ ...target, ...injected, settingsManager: settings,
        resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
          systemPrompt: 'Fade presentation session. All prompts are handled by Fade.',
          extensionFactories: [extension] } });
      const result = await createAgentSessionFromServices({ ...target, services,
        ...(options.companionModel ? { model: resolvePiModel(services.modelRegistry, options.companionModel, target.sessionManager.getSessionId()) } : {}),
        thinkingLevel: 'off', tools: [], noTools: 'all' });
      if (result.session.model) {
        options.companionModel = `${result.session.model.provider}/${result.session.model.id}`;
        if (builderFollowsSelection) options.builderModel = options.companionModel;
      }
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd: store.workspace, agentDir: getAgentDir(), sessionManager: manager });
    return { runtime, app, brand: () => ui?.setTitle(`Fade - ${store.workspace}`) };
  } catch (error) { await app.close(); throw error; }
}

export async function runTui(store: Store, options: PiOptions, initialMessage?: string): Promise<void> {
  // Fade owns its pinned SDK version; a stock Pi update notice is misleading here.
  process.env.PI_SKIP_VERSION_CHECK ??= '1';
  const { runtime, app, brand } = await createFadeRuntime(store, options);
  try {
    const mode = new InteractiveMode(runtime, initialMessage ? { initialMessage } : {});
    await mode.init(); brand();
    await mode.run();
  } finally { await runtime.dispose(); await app.close(); }
}
