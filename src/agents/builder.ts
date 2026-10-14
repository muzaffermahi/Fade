import { join } from 'node:path';
import {
  createAgentSession, defineTool, SessionManager, type AgentSession, type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import type { BuilderAgent, BuilderEvent, BuildOutcome, Card, Step } from '../types.js';
import { BUILDER_PROMPT, cardMessage } from './prompts.js';
import {
  assistantText, describeTool, errorMessage, lastRunError, loader, resolveModel, textDelta,
} from './pi.js';

const TOOL_NAMES = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls', 'fade_steps', 'fade_done', 'fade_stuck'];

export interface PiBuilderOptions {
  cwd: string;
  runtime: ModelRuntime;
  model?: string;
}

export class PiBuilder implements BuilderAgent {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private emit: (e: BuilderEvent) => void = () => undefined;
  private outcome: BuildOutcome | undefined;
  private stopped = false;
  private running = false;
  private streamed = '';

  constructor(private readonly opts: PiBuilderOptions) {}

  get busy(): boolean {
    return this.running;
  }

  async init(): Promise<void> {
    try {
      const model = resolveModel(this.opts.runtime, this.opts.model);
      const { session } = await createAgentSession({
        cwd: this.opts.cwd,
        modelRuntime: this.opts.runtime,
        ...(model ? { model } : {}),
        tools: TOOL_NAMES,
        customTools: this.customTools(),
        resourceLoader: await loader(this.opts.cwd, BUILDER_PROMPT),
        sessionManager: SessionManager.continueRecent(this.opts.cwd, join(this.opts.cwd, '.fade', 'sessions', 'builder')),
      });
      await session.bindExtensions({});
      this.unsubscribe = session.subscribe(event => this.onSessionEvent(event));
      this.session = session;
    } catch (error) {
      throw new Error(`Builder couldn't start: ${errorMessage(error)}`);
    }
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
      parameters: Type.Object({ summary: Type.String(), howToTry: Type.String() }),
      execute: async (_id, params) => {
        this.outcome = { kind: 'done', summary: params.summary, howToTry: params.howToTry };
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
    return [stepsTool, doneTool, stuckTool];
  }

  private onSessionEvent(event: { type: string } & Record<string, unknown>): void {
    if (!this.running) return;
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
    this.running = true;
    try {
      await session.prompt(cardMessage(card, context));
      if (this.stopped) return { kind: 'stopped' };
      if (this.outcome) return this.outcome;
      const runError = lastRunError(session.messages);
      if (runError) return { kind: 'failed', error: `Builder couldn't continue: ${runError}` };
      return { kind: 'done', summary: session.getLastAssistantText() ?? 'Finished.', howToTry: '' };
    } catch (error) {
      if (this.stopped) return { kind: 'stopped' };
      return { kind: 'failed', error: `Builder couldn't continue: ${errorMessage(error)}` };
    } finally {
      this.running = false;
    }
  }

  async note(text: string): Promise<void> {
    const session = this.session;
    if (!session || !session.isStreaming) return;
    await session.steer(`Note from the human: ${text}`);
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
