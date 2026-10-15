import { join } from 'node:path';
import {
  createAgentSession, defineTool, SessionManager, type AgentSession, type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BuilderAgent, SlashHost, BuilderEvent, BuildOutcome, Card, Step } from '../types.js';
import { BUILDER_PROMPT, cardMessage } from './prompts.js';
import {
  assistantText, describeTool, errorMessage, lastRunError, loader, resolveModel, textDelta,
} from './pi.js';
import { PiSlash } from './slash.js';

// Local and small models often answer in prose instead of calling tools; then nothing gets built.
const WEAK_TOOLS = 'The Builder model replied without using any tools, so nothing was built. ' +
  'Builders need strong tool calling: switch with /model in this pane (a weaker model can still be a fine Companion).';

const TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'fade_understood', 'fade_steps', 'fade_done', 'fade_stuck'];

export interface PiBuilderOptions {
  cwd: string;
  runtime: ModelRuntime;
  model?: string;
  onModelChange?: (selector: string) => void;
}

export class PiBuilder implements BuilderAgent {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private emit: (e: BuilderEvent) => void = () => undefined;
  private outcome: BuildOutcome | undefined;
  private stopped = false;
  private running = false;
  private streamed = '';
  private pendingNotes: string[] = [];
  /** Tool calls in the current run; zero means the model only chatted. */
  private toolCalls = 0;

  readonly slash: SlashHost;

  constructor(private readonly opts: PiBuilderOptions) {
    this.slash = new PiSlash({
      session: () => this.session,
      runtime: opts.runtime,
      sessionDir: this.sessionDir,
      fresh: () => this.open(true),
      reopen: () => this.open(false),
      ...(opts.onModelChange ? { onModelChange: opts.onModelChange } : {}),
      acceptsPrompts: false,
    });
  }

  private get sessionDir(): string {
    return join(this.opts.cwd, '.fade', 'sessions', 'builder');
  }

  get busy(): boolean {
    return this.running;
  }

  async init(): Promise<void> {
    try {
      await this.open(false);
    } catch (error) {
      throw new Error(`Builder couldn't start: ${errorMessage(error)}`);
    }
  }

  /** Opens the most recent session, or a brand-new one when `fresh` is set (for /new). */
  private async open(fresh: boolean): Promise<void> {
    const model = this.session?.model ?? resolveModel(this.opts.runtime, this.opts.model);
    const dir = this.sessionDir;
    const { session } = await createAgentSession({
      cwd: this.opts.cwd,
      modelRuntime: this.opts.runtime,
      ...(model ? { model } : {}),
      tools: TOOL_NAMES,
      customTools: this.customTools(),
      resourceLoader: await loader(this.opts.cwd, BUILDER_PROMPT),
      sessionManager: fresh ? SessionManager.create(this.opts.cwd, dir) : SessionManager.continueRecent(this.opts.cwd, dir),
    });
    await session.bindExtensions({});
    this.unsubscribe?.();
    this.session?.dispose();
    this.unsubscribe = session.subscribe(event => this.onSessionEvent(event));
    this.session = session;
  }

  private customTools() {
    const stepsTool = defineTool({
      name: 'fade_steps',
      label: 'Steps',
      description: 'Show the human your plan as 3-7 short steps. Call again to update statuses.',
      parameters: Type.Object({
        steps: Type.Array(Type.Object({
          text: Type.String(),
          status: Type.Union([Type.Literal('done'), Type.Literal('active'), Type.Literal('todo')]),
        })),
      }),
      execute: async (_id, params) => {
        const steps: Step[] = params.steps.map(s => ({ text: s.text, status: s.status }));
        this.emit({ type: 'steps', steps });
        return { content: [{ type: 'text', text: 'Steps updated.' }], details: undefined };
      },
    });
    const doneTool = defineTool({
      name: 'fade_done',
      label: 'Card done',
      description: 'Call when the card is finished and verified. This must be your final action.',
      parameters: Type.Object({
        summary: Type.String({ description: '1-2 plain sentences about what changed.' }),
        howToTry: Type.String({ description: 'One line telling the human how to see it working.' }),
        tryCommand: Type.Optional(Type.String({ description: 'One finite shell command that shows it working.' })),
        checks: Type.Optional(Type.Array(Type.Object({
          criterion: Type.String({ description: 'A "Done when" line from the card.' }),
          passed: Type.Boolean(),
          proof: Type.Optional(Type.String()),
          look: Type.Optional(Type.String()),
          evidence: Type.Optional(Type.String({ description: 'One line: what you ran or saw.' })),
        }))),
      }),
      execute: async (_id, params) => {
        const outcome: BuildOutcome = { kind: 'done', summary: params.summary, howToTry: params.howToTry };
        if (params.tryCommand?.trim()) outcome.tryCommand = params.tryCommand.trim();
        if (params.checks && params.checks.length > 0) {
          outcome.checks = params.checks.map(check => ({
            criterion: check.criterion, passed: check.passed,
            ...(check.proof?.trim() ? { proof: check.proof.trim() } : {}),
            ...(check.look?.trim() ? { look: check.look.trim() } : {}), ...(check.evidence ? { evidence: check.evidence } : {}),
          }));
        }
        this.outcome = outcome;
        return { content: [{ type: 'text', text: 'Recorded. Stop now.' }], details: undefined };
      },
    });
    const stuckTool = defineTool({
      name: 'fade_stuck',
      label: 'Stuck',
      description: 'Call when you cannot continue without a human decision. Ask ONE clear question, then stop.',
      parameters: Type.Object({ question: Type.String() }),
      execute: async (_id, params) => {
        this.outcome = { kind: 'stuck', question: params.question };
        return { content: [{ type: 'text', text: 'Recorded. Stop now.' }], details: undefined };
      },
    });
    const understoodTool = defineTool({
      name: 'fade_understood', label: 'Understood',
      description: 'For a card without Done-when lines, read back the requested outcome before building.',
      parameters: Type.Object({ outcome: Type.String(), assumptions: Type.Optional(Type.Array(Type.String())), doneWhen: Type.Array(Type.String(), { minItems: 1 }) }),
      execute: async (_id, params) => {
        this.emit({ type: 'understood', ...params });
        return { content: [{ type: 'text', text: 'Read-back recorded. Continue building.' }], details: undefined };
      },
    });
    return [understoodTool, stepsTool, doneTool, stuckTool];
  }

  private onSessionEvent(event: { type: string } & Record<string, unknown>): void {
    if (!this.running) return;
    this.flushNotes();
    if (event.type === 'message_update') {
      const delta = textDelta(event.assistantMessageEvent);
      if (delta) {
        this.streamed += delta;
        this.emit({ type: 'text', text: this.streamed });
      }
    } else if (event.type === 'message_end') {
      const text = assistantText(event.message);
      this.streamed = '';
      if (text?.trim()) this.emit({ type: 'message', text });
    } else if (event.type === 'tool_execution_start') {
      this.toolCalls += 1;
      const line = describeTool(this.opts.cwd, String(event.toolName), event.args);
      if (!String(event.toolName).startsWith('fade_')) this.emit({ type: 'action', text: line });
      this.emit({ type: 'log', line });
    } else if (event.type === 'tool_execution_end' && event.isError === true) {
      this.emit({ type: 'log', line: `✗ ${String(event.toolName)} failed` });
    }
  }

  async build(card: Card, context: string, onEvent: (e: BuilderEvent) => void): Promise<BuildOutcome> {
    const session = this.session;
    if (!session) return { kind: 'failed', error: 'Builder is not ready yet.' };
    this.emit = onEvent;
    this.outcome = undefined;
    this.stopped = false;
    this.streamed = '';
    this.pendingNotes = [];
    this.toolCalls = 0;
    this.running = true;
    try {
      await session.prompt(cardMessage(card, context));
      if (this.stopped) return { kind: 'stopped' };
      if (this.outcome) return this.outcome;
      const runError = lastRunError(session.messages);
      if (runError) return { kind: 'failed', error: `Builder couldn't continue: ${runError}` };
      if (this.toolCalls === 0) return { kind: 'unfinished', summary: WEAK_TOOLS };
      return { kind: 'unfinished', summary: session.getLastAssistantText() ?? 'The turn ended without fade_done.' };
    } catch (error) {
      if (this.stopped) return { kind: 'stopped' };
      return { kind: 'failed', error: `Builder couldn't continue: ${errorMessage(error)}` };
    } finally {
      this.running = false;
      this.pendingNotes = [];
    }
  }

  /** Notes sent before the run starts streaming are held, then steered in as soon as it does. */
  async note(text: string): Promise<void> {
    this.pendingNotes.push(text);
    this.flushNotes();
  }

  private flushNotes(): void {
    const session = this.session;
    if (!session || !this.running || !session.isStreaming || this.pendingNotes.length === 0) return;
    const notes = this.pendingNotes.splice(0);
    for (const text of notes) void session.steer(`Note from the human: ${text}`).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.session?.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session?.dispose();
  }
}
