import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, AuthStorage, ModelRegistry, SettingsManager,
  SessionManager, getAgentDir, createReadToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, createBashToolDefinition, createLocalBashOperations, defineTool, type AgentSession } from '@mariozechner/pi-coding-agent';
import { BuilderSchema, CompanionSchema, parseResponse, type ProjectState, type Slice } from './contracts.js';
import type { TSchema, Static } from '@sinclair/typebox';
import type { Agents } from './coordinator.js';
import { Store } from './store.js';
import { BUILDER_PROMPT, COMPANION_PROMPT } from './prompts.js';
import { routineCommand, workspacePath } from './workspace.js';

export interface PiOptions {
  builderModel?: string; companionModel?: string;
  approve?: (command: string, signal: AbortSignal | undefined) => Promise<boolean>;
}
/** Real Pi sessions with separate contexts, tools, and persisted session references. */
export class PiAgents implements Agents {
  private readonly active = new Set<AgentSession>();
  private readonly auth = AuthStorage.create();
  private readonly registry = ModelRegistry.create(this.auth);
  constructor(private readonly store: Store, private readonly state: ProjectState, private readonly options: PiOptions = {}) {}
  async build(slice: Slice, signal: AbortSignal, emit: (event: unknown) => void) {
    const root = this.store.workspace;
    const checkedRead = async (path: string) => readFile(await workspacePath(root, path));
    const checkedAccess = async (path: string) => access(await workspacePath(root, path));
    const checkedWrite = async (path: string, content: string) => writeFile(await workspacePath(root, path), content);
    const read = createReadToolDefinition(root, { operations: { readFile: checkedRead, access: checkedAccess } });
    const write = createWriteToolDefinition(root, { operations: { writeFile: checkedWrite,
      mkdir: async path => { await mkdir(await workspacePath(root, path), { recursive: true }); } } });
    const edit = createEditToolDefinition(root, { operations: { readFile: checkedRead, writeFile: checkedWrite, access: checkedAccess } });
    const local = createLocalBashOperations();
    const bash = createBashToolDefinition(root, { operations: { exec: async (command, cwd, options) => {
      if (!routineCommand(command)) {
        const allowed = await this.options.approve?.(command, options.signal);
        if (!allowed) throw new Error('Command needs explicit human consent. Report blocked if it is necessary.');
      }
      if (signal.aborted) throw new Error('Builder cancelled');
      return local.exec(command, cwd, options);
    } } });
    const actual = await this.session('builder', [
      defineTool({ ...read, name: 'workspace_read' }), defineTool({ ...write, name: 'workspace_write' }),
      defineTool({ ...edit, name: 'workspace_edit' }), defineTool({ ...bash, name: 'workspace_bash' })
    ]);
    const off = actual.subscribe(event => {
      if (event.type === 'tool_execution_start') emit(`Pi is using ${event.toolName}`);
      if (event.type === 'tool_execution_start' || event.type === 'tool_execution_end' || event.type === 'message_end') emit(event);
    });
    try {
      return await this.structured(actual, JSON.stringify({ slice: slice.plan, snapshot: slice.snapshot }), BuilderSchema, signal);
    } finally { off(); actual.dispose(); this.active.delete(actual); }
  }
  async converse(state: ProjectState, message: string, signal: AbortSignal) {
    const session = await this.session('companion');
    try {
      const context = { trigger: message ? 'human-conversation' : 'builder-discovery-reconciliation',
        instruction: message ? 'Engage with the current human message.' : 'Reconcile held future briefs against actual discoveries and existing settled intent. There is no new human message. Return evidence=[]; do not invent decisions. Revise a brief if it can proceed safely, otherwise explain the remaining uncertainty and keep it unready.',
        preference: state.preference, intent: state.intent,
        slices: state.slices.filter(s => s.status !== 'cancelled').slice(-8),
        discoveries: state.discoveries.slice(-10), conversation: state.conversation.slice(-12),
        currentHumanMessage: message };
      return await this.structured(session, JSON.stringify(context), CompanionSchema, signal);
    } finally { session.dispose(); this.active.delete(session); }
  }
  close(): void { for (const s of this.active) s.dispose(); this.active.clear(); }
  private async structured<S extends TSchema>(session: AgentSession, input: string, schema: S, signal: AbortSignal): Promise<Static<S>> {
    const raw = await this.prompt(session, input, signal);
    try { return parseResponse(schema, raw); } catch (error) {
      // One formatting repair, never a repeated implementation run or silent coercion.
      session.setActiveToolsByName([]);
      const reason = error instanceof Error ? error.message : String(error);
      const repaired = await this.prompt(session, `Your previous response was rejected: ${reason}. Repair its JSON format exactly to the following schema. No tools are available. Preserve what actually happened; do not invent work, quotes, or verification. Evidence quotes must come verbatim from currentHumanMessage in the previous context. Omit unsupported evidence. Return only JSON. Schema: ${JSON.stringify(schema)}`, signal);
      return parseResponse(schema, repaired);
    }
  }
  async models(): Promise<string[]> {
    const models = this.registry.getAvailable().map(m => `${m.provider}/${m.id}`);
    if (models.includes('opencode-go/deepseek-v4-flash') && !models.includes('opencode-go/deepseek-v4.1-flash')) models.push('opencode-go/deepseek-v4.1-flash');
    return models;
  }
  private async session(role: 'builder' | 'companion', tools: NonNullable<Parameters<typeof createAgentSession>[0]>['customTools'] = []) {
    // Preserve Pi model defaults and credentials; disable package/resource discovery.
    const loader = new DefaultResourceLoader({ cwd: this.store.workspace, agentDir: getAgentDir(),
      settingsManager: SettingsManager.inMemory({ packages: [], extensions: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      systemPrompt: role === 'builder' ? BUILDER_PROMPT : COMPANION_PROMPT });
    await loader.reload();
    const selector = (role === 'builder' ? this.options.builderModel : this.options.companionModel) ?? 'opencode-go/deepseek-v4.1-flash';
    const separator = selector.indexOf('/');
    if (separator <= 0 || separator === selector.length - 1) throw new Error('Use model format provider/model-id.');
    const provider = selector.slice(0, separator), id = selector.slice(separator + 1);
    let model = this.registry.find(provider, id);
    // The requested Pi release predates this official Go catalog entry. Reuse the
    // same OpenAI-compatible transport and conservative limits without changing user config.
    if (!model && provider === 'opencode-go' && id === 'deepseek-v4.1-flash') {
      const base = this.registry.find('opencode-go', 'deepseek-v4-flash');
      if (base) model = { ...base, id, name: 'DeepSeek V4.1 Flash',
        cost: { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 } };
    }
    if (!model) throw new Error('No Pi model configured. Run pi /login or configure ~/.pi/agent/models.json; /models lists available models.');
    const sessionsDir = join(this.store.directory, 'sessions', role); await mkdir(sessionsDir, { recursive: true });
    // Full history stays in Pi files and journal. Each turn has a concise explicit context, preventing stale hidden briefs.
    const manager = SessionManager.create(this.store.workspace, sessionsDir);
    if (model.provider === 'opencode-go') model = { ...model, headers: {
      ...model.headers, 'x-opencode-session': manager.getSessionId()
    } };
    const { session } = await createAgentSession({ cwd: this.store.workspace, model,
      thinkingLevel: 'off', authStorage: this.auth, modelRegistry: this.registry,
      resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 1 }, compaction: { enabled: true } }),
      tools: tools?.map(t => t.name) ?? [], customTools: tools ?? [] });
    this.active.add(session);
    const file = manager.getSessionFile();
    if (file) {
      if (role === 'companion') this.state.sessions.companion = file;
      else this.state.sessions.builders.push(file);
      this.store.save(this.state);
    }
    return session;
  }
  private async prompt(session: AgentSession, text: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) throw new Error('Agent cancelled');
    const abort = () => { void session.abort(); };
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10 * 60 * 1000);
    try {
      await session.prompt(text, { expandPromptTemplates: false });
      const last = session.messages.filter(m => m.role === 'assistant').at(-1);
      if (!last || last.role !== 'assistant') throw new Error('Pi returned no assistant response.');
      if (last.stopReason === 'error' || last.stopReason === 'aborted') throw new Error(last.errorMessage || `Pi ${last.stopReason}`);
      const reply = last.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      if (!reply.trim()) throw new Error('Pi returned an empty response.');
      return reply;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
}
