import {
  InteractiveMode, SessionManager, SettingsManager, createAgentSessionRuntime,
  createAgentSessionServices, createAgentSessionFromServices, getAgentDir, getMarkdownTheme,
  CustomEditor, UserMessageComponent, defineTool, type AgentSession, type ExtensionAPI, type ExtensionFactory, type ExtensionUIContext,
  type CreateAgentSessionServicesOptions,
} from '@earendil-works/pi-coding-agent';
import { Container, Markdown, Spacer, Text } from '@earendil-works/pi-tui';
import { join, resolve } from 'node:path';
import { FadeApp, type AgentFactory } from './app.js';
import { errorText, type Agents, type Notice } from './coordinator.js';
import { IntentUpdateSchema, validate, type IntentUpdate } from './contracts.js';
import { Store } from './store.js';
import { PiAgents, resolvePiModel, type PiOptions } from './pi.js';
import { piBuiltins } from './pi-resources.js';
import { NATIVE_COMPANION_PROMPT } from './prompts.js';
import { sliceReport } from './reports.js';

type Images = NonNullable<Parameters<AgentSession['prompt']>[1]>['images'];
const HELP = `Write an ordinary prompt to use Fade's Companion and automatic Builder loop.
Pi's native tools, shell input (! / !!), extensions, skills, templates, sessions, model selection, and settings remain available.
/status · /intent · /pause · /stop · /continue · /redirect <direction>
/builder <message> · /companion <message> · /reports · /log
/apply-intent · /rethink · /history · /log · /preference design|technical
Escape interrupts Fade. /quit saves and exits. /continue restarts a recovered Builder.`;

/** Real Pi conversation and tools, with Fade's durable loop on every ordinary prompt. */
export async function createFadeRuntime(initialStore: Store, options: PiOptions = {}, factory?: AgentFactory,
  injected: Pick<CreateAgentSessionServicesOptions, 'modelRuntime' | 'settingsManager'> = {}) {
  let store = initialStore;
  let session: AgentSession | undefined;
  let api: ExtensionAPI | undefined;
  let ui: ExtensionUIContext | undefined;
  let pending: { context: string; update?: IntentUpdate } | undefined;
  let streamedReply: string | undefined;
  const attachments: { text: string; images: Images }[] = [];
  const builderFollowsSelection = !options.builderModel;
  const send = (type: string, text: string) => api?.sendMessage({ customType: type, content: text, display: true }, { triggerTurn: false });
  const show = (notice: Notice) => {
    if (notice.role === 'companion' && notice.text === streamedReply) { streamedReply = undefined; return; }
    if (notice.role === 'builder') {
      ui?.setStatus('fade-builder', notice.text.startsWith('Pi is using ')
        ? `Builder · ${notice.text.slice('Pi is using '.length)}`
        : /^(completed|blocked|interrupted):/.test(notice.text) ? `Builder ${notice.text.split(':')[0]}` : notice.text);
      if (!/^(completed|blocked|interrupted):/.test(notice.text)) return;
      const latest = app.coordinator?.state.slices.findLast(slice => slice.status === 'completed' || slice.status === 'blocked' || slice.status === 'interrupted');
      send('fade-builder', latest ? sliceReport(latest) : `Builder · ${notice.text}`);
      return;
    }
    send(notice.role === 'companion' ? 'fade-companion' : 'fade-note', notice.text.replaceAll('/resume', '/continue'));
  };
  const converse: Agents['converse'] = async (state, message, signal) => {
    // An input hook must return before starting the native session's model loop.
    await new Promise<void>(done => setImmediate(done));
    if (!session || signal.aborted) throw new Error('Conversation interrupted.');
    const actual = session;
    const request: NonNullable<typeof pending> = { context: JSON.stringify({
      trigger: message ? 'human-conversation' : 'builder-discovery-reconciliation',
      currentHumanMessage: message, intent: state.intent, preference: state.preference,
      slices: state.slices.filter(s => s.status !== 'cancelled').slice(-8), discoveries: state.discoveries.slice(-10),
      builderNotes: state.builderMessages?.slice(-8) ?? [],
    }) };
    pending = request;
    const index = attachments.findIndex(item => item.text === message);
    const images = index >= 0 ? attachments.splice(index, 1)[0]?.images : undefined;
    const abort = () => { void actual.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10 * 60 * 1000);
    try {
      const file = actual.sessionManager.getSessionFile();
      if (file && app.coordinator) { app.coordinator.state.sessions.companion = file; store.save(app.coordinator.state); }
      await actual.prompt(message || 'Reconcile the latest Builder discoveries with our existing intent and future slice. There is no new human decision.',
        { source: 'extension', ...(images ? { images } : {}) });
      const last = actual.messages.filter(m => m.role === 'assistant').at(-1);
      if (!last || last.role !== 'assistant') throw new Error('Pi returned no assistant response.');
      if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(last.errorMessage || `Pi ${last.stopReason}`);
      const reply = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!reply.trim()) throw new Error('Pi returned an empty response.');
      streamedReply = reply;
      return { reply, ...(request.update ?? { evidence: [], openQuestions: state.intent.openQuestions, next: null }) };
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); pending = undefined; }
  };
  const nativeFactory: AgentFactory = (s, state, o) => new PiAgents(s, state, o, converse);
  const makeApp = () => new FadeApp(store, options, show, value => ui?.setStatus('fade-companion', value),
    (s, state, o) => (factory ?? nativeFactory)(s, state, o, converse));
  let app = makeApp();
  const extension: ExtensionFactory = pi => {
    api = pi;
    pi.registerMessageRenderer('fade-human', message => new UserMessageComponent(String(message.content)));
    for (const type of ['fade-companion', 'fade-note', 'fade-builder']) pi.registerMessageRenderer(type, (message, _options, theme) => {
      const component = new Container(); component.addChild(new Spacer(1));
      if (type === 'fade-note') component.addChild(new Text(theme.fg('dim', 'Fade'), 1, 0));
      component.addChild(new Markdown(String(message.content), 1, 0, getMarkdownTheme())); return component;
    });
    pi.registerTool(defineTool({ name: 'fade_update_intent', label: 'Living Intent',
      description: 'Propose source-backed intent and one future slice for Fade. Human evidence quotes must come verbatim from the current human message. Never derive human decisions from tool results.',
      parameters: IntentUpdateSchema,
      execute: async (_id, params) => {
        if (!pending) throw new Error('Intent proposals require an active Fade conversation.');
        pending.update = validate(IntentUpdateSchema, params);
        return { content: [{ type: 'text', text: 'Proposal recorded for coordinator validation when this conversation completes.' }], details: {} };
      },
      renderCall: (_args, theme) => new Text(theme.fg('accent', 'Updating Living Intent'), 0, 0),
      renderResult: (_result, _opts, theme) => new Text(theme.fg('dim', 'Intent proposal recorded'), 0, 0),
    }));
    pi.on('before_agent_start', event => {
      event.systemPromptOptions.sections.fade = `${NATIVE_COMPANION_PROMPT}\n\nFade context:\n${pending?.context ?? 'No active intent update. Use Pi normally.'}`;
    });
    pi.on('session_start', (_event, ctx) => {
      ui = ctx.hasUI ? ctx.ui : undefined;
      ctx.ui.setHeader((_tui, theme) => new Text(`${theme.bold(theme.fg('accent', 'Fade'))} · ${theme.fg('dim', 'a tool for the mind')}\n${theme.fg('dim', 'Companion by default · /builder <message> · /reports · /help')}`, 1, 1));
      ctx.ui.setTitle(`Fade - ${store.workspace}`);
      ctx.ui.setStatus('fade-companion', 'Companion ready');
      ctx.ui.setStatus('fade-builder', app.coordinator ? 'Builder paused · /continue' : 'Builder ready');
      ctx.ui.setEditorComponent((tui, theme, keybindings) => new class extends CustomEditor {
        override handleInput(data: string): void {
          if (keybindings.matches(data, 'app.interrupt') && !this.isShowingAutocomplete() && app.busy) {
            void app.interrupt().catch(error => ctx.ui.notify(errorText(error), 'error')); return;
          }
          super.handleInput(data);
        }
      }(tui, theme, keybindings));
    });
    pi.on('input', (event, ctx) => {
      if (event.source === 'extension' && pending) return { action: 'continue' };
      options.companionThinkingLevel = pi.getThinkingLevel();
      if (event.images?.length) attachments.push({ text: event.text, images: event.images });
      void app.submit(event.text).catch(error => { ctx.ui.setEditorText(event.text); ctx.ui.notify(errorText(error), 'error'); });
      return { action: 'handled' };
    });
    pi.on('model_select', event => {
      options.companionModel = `${event.model.provider}/${event.model.id}`;
      if (builderFollowsSelection) options.builderModel = options.companionModel;
    });
    pi.on('thinking_level_select', event => { options.companionThinkingLevel = event.level; });
    const interrupt = async () => { if (app.busy) await app.interrupt(); };
    pi.on('session_before_switch', interrupt);
    pi.on('session_before_fork', interrupt);
    pi.on('session_before_tree', interrupt);
    pi.on('session_shutdown', async event => { if (event.reason === 'quit') await app.close(); });
    pi.registerCommand('help', { description: 'Fade controls and Pi capabilities', handler: async () => { send('fade-note', HELP); } });
    for (const name of ['builder', 'companion', 'reports', 'status', 'intent', 'apply-intent', 'rethink', 'pause', 'stop', 'continue', 'redirect', 'history', 'log', 'preference']) {
      pi.registerCommand(name, { description: `Fade ${name}`, handler: async (args, ctx) => {
        try { await app.command(name, args.trim()); } catch (error) { ctx.ui.notify(errorText(error), 'error'); }
      } });
    }
  };
  const manager = SessionManager.continueRecent(store.workspace, join(store.directory, 'sessions', 'conversation'));
  if (!manager.getEntries().some(entry => entry.type === 'message' || entry.type === 'custom_message')) {
    for (const message of app.history()) manager.appendCustomMessageEntry(
      message.role === 'human' ? 'fade-human' : 'fade-companion', message.text, true);
  }
  manager.appendSessionInfo('Fade');
  try {
    const builtins = await piBuiltins();
    const runtime = await createAgentSessionRuntime(async target => {
      if (resolve(target.cwd) !== resolve(store.workspace)) {
        await app.close(); store = new Store(target.cwd); store.lock(); app = makeApp();
      }
      const services = await createAgentSessionServices({ ...target, ...injected,
        settingsManager: injected.settingsManager ?? SettingsManager.create(target.cwd, getAgentDir()),
        resourceLoaderOptions: { extensionFactories: [...builtins, { name: 'Fade', factory: extension, hidden: true }] } });
      const result = await createAgentSessionFromServices({ ...target, services,
        ...(options.companionModel ? { model: resolvePiModel(services.modelRuntime, options.companionModel, target.sessionManager.getSessionId()) } : {}) });
      session = result.session;
      if (session.model) {
        options.companionModel = `${session.model.provider}/${session.model.id}`;
        if (builderFollowsSelection) options.builderModel = options.companionModel;
        if (session.model.provider === 'opencode-go') await session.setModel(resolvePiModel(services.modelRuntime, options.companionModel, target.sessionManager.getSessionId()));
      }
      return { ...result, services, diagnostics: services.diagnostics };
    }, { cwd: store.workspace, agentDir: getAgentDir(), sessionManager: manager });
    return { runtime, get app() { return app; }, brand: () => ui?.setTitle(`Fade - ${store.workspace}`) };
  } catch (error) { await app.close(); throw error; }
}

export async function runTui(store: Store, options: PiOptions, initialMessage?: string): Promise<void> {
  process.env.PI_SKIP_VERSION_CHECK ??= '1';
  const bridge = await createFadeRuntime(store, options);
  try {
    const mode = new InteractiveMode(bridge.runtime, initialMessage ? { initialMessage } : {});
    await mode.init(); bridge.brand(); await mode.run();
  } finally { await bridge.runtime.dispose(); await bridge.app.close(); }
}
