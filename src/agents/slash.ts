import { type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { SlashCommand } from '@earendil-works/pi-tui';
import type { SlashHost, SlashResult } from '../types.js';
import { errorMessage } from './pi.js';

export interface SlashTarget {
  session(): AgentSession | undefined;
  runtime: ModelRuntime;
  fresh(): Promise<void>;
  /** Called after a successful model switch, so the choice sticks next time. */
  onModelChange?(selector: string): void;
  /** Whether skills and prompt templates can be sent to this agent as a message. */
  acceptsPrompts: boolean;
}

function toast(text: string, extra: Partial<Extract<SlashResult, { kind: 'toast' }>> = {}): SlashResult {
  return { kind: 'toast', text, ...extra };
}

function modelName(session: AgentSession): string {
  const model = session.model;
  return model ? `${model.provider}/${model.id}` : 'none';
}

/** Pi's slash commands, run against one agent's session. */
export class PiSlash implements SlashHost {
  constructor(private readonly target: SlashTarget) {}

  commands(): SlashCommand[] {
    const session = this.target.session();
    const templates = session?.promptTemplates.map(t => ({ name: t.name, description: t.description })) ?? [];
    const skills = session?.resourceLoader.getSkills().skills.map(s => ({ name: `skill:${s.name}`, description: s.description })) ?? [];
    return [...templates, ...skills];
  }

  async run(text: string): Promise<SlashResult> {
    const session = this.target.session();
    if (!session) return toast('Not ready yet.');
    const space = text.indexOf(' ');
    const name = space === -1 ? text.slice(1) : text.slice(1, space);
    const args = space === -1 ? '' : text.slice(space + 1).trim();
    try {
      return await this.dispatch(session, name, args, text);
    } catch (error) {
      return toast(`/${name} failed: ${errorMessage(error)}`);
    }
  }

  private async dispatch(session: AgentSession, name: string, args: string, text: string): Promise<SlashResult> {
    switch (name) {
      case 'model': return this.model(session, args);
      case 'new': return this.fresh(session);
      case 'login': return toast('Run pi in another terminal, use /login there, then restart Fade.');
    }
    const isTemplate = session.promptTemplates.some(t => t.name === name);
    const isSkill = name.startsWith('skill:')
      && session.resourceLoader.getSkills().skills.some(s => `skill:${s.name}` === name);
    if (isTemplate || isSkill) {
      if (this.target.acceptsPrompts) return { kind: 'prompt', text };
      return toast('Skills and prompt templates go to the Companion.');
    }
    return toast(`Unknown command /${name}. Type / to see the list.`);
  }

  private async model(session: AgentSession, selector: string): Promise<SlashResult> {
    if (!selector) {
      const models = (await this.target.runtime.getAvailable()).map(m => `${m.provider}/${m.id}`);
      return { kind: 'pick-model', models, current: modelName(session) };
    }
    return this.setModel(selector);
  }

  async setModel(selector: string): Promise<SlashResult> {
    const session = this.target.session();
    if (!session) return toast('Not ready yet.');
    const slash = selector.indexOf('/');
    const model = slash > 0 ? this.target.runtime.getModel(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
    if (!model) return toast(`Unknown model "${selector}". Use provider/model.`);
    await session.setModel(model);
    this.target.onModelChange?.(selector);
    return toast(`Model: ${selector}`, { model: selector });
  }

  private async fresh(session: AgentSession): Promise<SlashResult> {
    if (session.isStreaming) return toast('Still working. Press Esc first, then /new.');
    await this.target.fresh();
    return toast('New session started', { newSession: true });
  }

}
