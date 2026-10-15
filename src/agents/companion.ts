import { join } from 'node:path';
import {
  createAgentSession, defineTool, SessionManager, type AgentSession, type ModelRuntime,
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { doneWhenLines, serializePlan } from '../plan.js';
import type { CompanionAgent, SlashHost, CompanionEvent, PlanApi } from '../types.js';
import { COMPANION_PROMPT } from './prompts.js';
import {
  assistantText, describeTool, errorMessage, lastRunError, loader, resolveModel, textDelta,
} from './pi.js';
import { WEB_TOOLS } from './pi.js';
import { PiSlash } from './slash.js';

// Read-only built-ins plus the Fade card tools. No edit, write or bash.
export const COMPANION_TOOLS = [
  'read', 'grep', 'find', 'ls', ...WEB_TOOLS,
  'fade_queue', 'fade_ready', 'fade_note_builder', 'fade_stop_builder', 'fade_accept',
  'fade_revise', 'fade_undo', 'fade_show', 'fade_move',
  'fade_add_card', 'fade_edit_card', 'fade_read_plan', 'fade_park', 'fade_promote_later',
];

export interface PiCompanionOptions {
  cwd: string;
  runtime: ModelRuntime;
  plan: PlanApi;
  model?: string;
  onModelChange?: (selector: string) => void;
}

export class PiCompanion implements CompanionAgent {
  private session: AgentSession | undefined;
  private unsubscribe: (() => void) | undefined;
  private emit: (e: CompanionEvent) => void = () => undefined;
  private running = false;
  private streamed = '';

  readonly slash: SlashHost;

  constructor(private readonly opts: PiCompanionOptions) {
    this.slash = new PiSlash({
      session: () => this.session,
      runtime: opts.runtime,
      fresh: () => this.open(true),
      ...(opts.onModelChange ? { onModelChange: opts.onModelChange } : {}),
      acceptsPrompts: true,
    });
  }

  private get sessionDir(): string {
    return join(this.opts.cwd, '.fade', 'sessions', 'companion');
  }

  get busy(): boolean {
    return this.running;
  }

  async init(): Promise<void> {
    try {
      await this.open(false);
    } catch (error) {
      throw new Error(`Companion couldn't start: ${errorMessage(error)}`);
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
      tools: COMPANION_TOOLS,
      excludeTools: ['mcp__*', 'codemode', 'tool_search'],
      customTools: this.customTools(),
      resourceLoader: await loader(this.opts.cwd, COMPANION_PROMPT),
      sessionManager: fresh ? SessionManager.create(this.opts.cwd, dir) : SessionManager.continueRecent(this.opts.cwd, dir),
    });
    await session.bindExtensions({});
    this.unsubscribe?.();
    this.session?.dispose();
    this.unsubscribe = session.subscribe(event => this.onSessionEvent(event));
    this.session = session;
  }

  private customTools() {
    const plan = this.opts.plan;
    const addTool = defineTool({
      name: 'fade_add_card',
      label: 'Add card',
      description: 'Add a draft card to the plan. Title: at most 5 words. Body: 1-4 sentences ending in "Done when: ...".',
      parameters: Type.Object({ title: Type.String(), body: Type.String() }),
      execute: async (_id, params) => {
        const title = plan.addCard(params.title, params.body);
        this.emit({ type: 'card', title, action: 'added' });
        return { content: [{ type: 'text', text: `Added draft card "${title}".` }], details: undefined };
      },
    });
    const editTool = defineTool({
      name: 'fade_edit_card',
      label: 'Edit card',
      description: 'Change the title and/or body of an existing card (not one that is building).',
      parameters: Type.Object({
        title: Type.String(),
        newTitle: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
        const target = plan.list().find(card => card.title === params.title);
        if (!target) throw new Error(`There is no card titled "${params.title}". Use fade_read_plan to see the plan.`);
        if (target.state === 'building') throw new Error('That card is being built right now; leave it alone.');
        const patch: { title?: string; body?: string } = {};
        if (params.newTitle !== undefined) patch.title = params.newTitle;
        if (params.body !== undefined) patch.body = params.body;
        plan.editCard(params.title, patch);
        this.emit({ type: 'card', title: params.newTitle ?? params.title, action: 'edited' });
        return { content: [{ type: 'text', text: 'Card updated.' }], details: undefined };
      },
    });
    const readTool = defineTool({
      name: 'fade_read_plan',
      label: 'Read plan',
      description: 'Return the current PLAN.md: pending requests and the parked Later ideas.',
      parameters: Type.Object({}),
      execute: async () => {
        const text = serializePlan({ preamble: '# Plan\n', goal: '', cards: plan.list(), later: plan.later(), done: [] });
        return { content: [{ type: 'text', text }], details: undefined };
      },
    });
    return [addTool, editTool, readTool, ...this.threadTools(), ...this.actionTools()];
  }

  /** Save tangents and bring parked ideas back when requested. */
  private threadTools() {
    const plan = this.opts.plan;
    const parkTool = defineTool({
      name: 'fade_park',
      label: 'Park for later',
      description: 'Save an idea that the human wants to revisit later into the Later list (one line).',
      parameters: Type.Object({ idea: Type.String() }),
      execute: async (_id, params) => {
        plan.park(params.idea);
        this.emit({ type: 'parked', text: params.idea.trim() });
        return { content: [{ type: 'text', text: 'Parked in Later.' }], details: undefined };
      },
    });
    const promoteTool = defineTool({
      name: 'fade_promote_later',
      label: 'Promote from Later',
      description: 'Turn a parked Later item into a draft card to discuss now.',
      parameters: Type.Object({ item: Type.String(), title: Type.String(), body: Type.String() }),
      execute: async (_id, params) => {
        const title = plan.promote(params.item, params.title, params.body);
        this.emit({ type: 'card', title, action: 'added' });
        return { content: [{ type: 'text', text: `Added draft card "${title}".` }], details: undefined };
      },
    });
    return [parkTool, promoteTool];
  }

  private actionTools() {
    const plan = this.opts.plan;
    const result = (text: string) => ({ content: [{ type: 'text' as const, text }], details: undefined });
    const titleTool = (name: string, description: string, act: (title: string) => void) => defineTool({
      name, label: description, description,
      parameters: Type.Object({ title: Type.String() }),
      execute: async (_id, params) => {
        act(params.title);
        return result('Done.');
      },
    });
    return [
      defineTool({
        name: 'fade_queue', label: 'Build requested card',
        description: 'Queue a ready card at the end. Only when the latest human message asks for the work.',
        parameters: Type.Object({
          title: Type.String(),
          body: Type.String({ description: 'Plain Done when: lines; subjective work needs a human approval criterion.' }),
        }),
        execute: async (_id, params) => {
          if (doneWhenLines(params.body).length === 0) {
            throw new Error('Put each Done when: criterion on its own line, then call fade_queue again.');
          }
          const title = plan.queue(params.title, params.body);
          return result(`Building or queued: ${title}`);
        },
      }),
      titleTool('fade_ready', 'Ready the draft the human agreed to', title => plan.ready(title)),
      titleTool('fade_accept', 'Accept the result the human approved', title => plan.accept(title)),
      titleTool('fade_undo', 'Undo the checkpoint the human requested', title => plan.undo(title)),
      titleTool('fade_show', 'Show summary, checks, files and diff', title => plan.show(title)),
      defineTool({
        name: 'fade_note_builder', label: 'Steer work', description: 'Forward the human note to the current build.',
        parameters: Type.Object({ text: Type.String() }),
        execute: async (_id, params) => {
          plan.noteBuilder(params.text);
          return result('Note sent.');
        },
      }),
      defineTool({
        name: 'fade_stop_builder', label: 'Stop work', description: 'Stop the build at the human request.',
        parameters: Type.Object({}),
        execute: async () => {
          await plan.stopBuilder();
          return result('Stopped.');
        },
      }),
      defineTool({
        name: 'fade_revise', label: 'Revise card',
        description: 'Replace the body. startOver reverts the checkpoint first for a misunderstood ask.',
        parameters: Type.Object({ title: Type.String(), body: Type.String(), startOver: Type.Boolean() }),
        execute: async (_id, params) => {
          if (doneWhenLines(params.body).length === 0) throw new Error('Put each Done when: criterion on its own line, after a newline.');
          await plan.revise(params.title, params.body, params.startOver);
          return result('Revised and queued.');
        },
      }),
      defineTool({
        name: 'fade_move', label: 'Reorder card', description: 'Move a card to the top or end of the queue when asked.',
        parameters: Type.Object({ title: Type.String(), toTop: Type.Boolean() }),
        execute: async (_id, params) => {
          plan.move(params.title, params.toTop);
          return result('Moved.');
        },
      }),
    ];
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
      const name = String(event.toolName);
      if (!name.startsWith('fade_')) this.emit({ type: 'tool', text: describeTool(this.opts.cwd, name, event.args) });
    }
  }

  async send(text: string, context: string, onEvent: (e: CompanionEvent) => void): Promise<void> {
    const session = this.session;
    if (!session) throw new Error('Companion is not ready yet.');
    // Slash text goes to Pi untouched so it can expand skills and prompt templates.
    const message = text.startsWith('/') ? text : `<fade-context>\n${context}\n</fade-context>\n\n${text}`;
    if (this.running) {
      await session.followUp(message);
      return;
    }
    this.emit = onEvent;
    this.streamed = '';
    this.running = true;
    try {
      await session.prompt(message);
      const runError = lastRunError(session.messages);
      if (runError) throw new Error(runError);
    } finally {
      this.running = false;
    }
  }

  async stop(): Promise<void> {
    await this.session?.abort();
  }

  dispose(): void {
    this.unsubscribe?.();
    this.session?.dispose();
  }
}
