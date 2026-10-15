import { copyToClipboard, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import type { SlashHost, SlashResult } from '../types.js';
import { errorMessage } from './pi.js';

/** Pi commands that need Pi's own screens (pickers, trees, menus). */
const PI_ONLY = new Set([
  'settings', 'tree', 'scoped-models', 'export', 'import', 'share', 'bug', 'name', 'changelog',
  'fork', 'clone', 'trust', 'logout', 'resume',
]);

export interface SlashTarget {
  session(): AgentSession | undefined;
  runtime: ModelRuntime;
  /** Replace the agent's session with a brand-new one. */
  fresh(): Promise<void>;
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

function matching(values: string[], prefix: string): AutocompleteItem[] {
  const lower = prefix.toLowerCase();
  return values.filter(value => value.toLowerCase().includes(lower)).map(value => ({ value, label: value }));
}

/** Pi's slash commands, run against one agent's session. */
export class PiSlash implements SlashHost {
  constructor(private readonly target: SlashTarget) {}

  commands(): SlashCommand[] {
    const session = this.target.session();
    const builtIn: SlashCommand[] = [
      {
        name: 'model', description: 'Switch model', argumentHint: '<provider/model>',
        getArgumentCompletions: async prefix => {
          const models = await this.target.runtime.getAvailable();
          return matching(models.map(m => `${m.provider}/${m.id}`), prefix);
        },
      },
      {
        name: 'thinking', description: 'Set thinking level', argumentHint: '<level>',
        getArgumentCompletions: prefix => matching(this.target.session()?.getAvailableThinkingLevels() ?? [], prefix),
      },
      { name: 'new', description: 'Start a new session' },
      { name: 'compact', description: 'Compact the session context', argumentHint: '[instructions]' },
      { name: 'session', description: 'Show session info and stats' },
      { name: 'copy', description: 'Copy the last reply to the clipboard' },
      { name: 'reload', description: 'Reload extensions, skills, prompts and context files' },
      { name: 'login', description: 'Connect a model provider' },
    ];
    if (!session) return builtIn;
    const extensions = session.extensionRunner.getRegisteredCommands().map(cmd => ({
      name: cmd.invocationName,
      ...(cmd.description ? { description: cmd.description } : {}),
      ...(cmd.getArgumentCompletions ? { getArgumentCompletions: cmd.getArgumentCompletions } : {}),
    }));
    if (!this.target.acceptsPrompts) return [...builtIn, ...extensions];
    const templates = session.promptTemplates.map(t => ({
      name: t.name, description: t.description, ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
    }));
    const skills = session.resourceLoader.getSkills().skills.map(s => ({ name: `skill:${s.name}`, description: s.description }));
    return [...builtIn, ...extensions, ...templates, ...skills];
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
      case 'thinking': return this.thinking(session, args);
      case 'new': return this.fresh(session);
      case 'compact': return this.compact(session, args);
      case 'session': return { kind: 'info', text: sessionInfo(session) };
      case 'copy': return this.copy(session);
      case 'reload':
        await session.reload();
        return toast('Reloaded');
      case 'login': return toast('Quit Fade (Ctrl+C twice) and run `fade login` to connect a provider.');
    }
    if (PI_ONLY.has(name)) return toast(`/${name} needs Pi's own screen. Run \`pi\` in a terminal for that.`);
    if (session.extensionRunner.getCommand(name)) {
      await session.prompt(text);
      return toast(`Ran /${name}`);
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
    if (!selector) return toast(`Model: ${modelName(session)}. Type /model and a name to switch.`);
    const slash = selector.indexOf('/');
    const model = slash > 0 ? this.target.runtime.getModel(selector.slice(0, slash), selector.slice(slash + 1)) : undefined;
    if (!model) return toast(`Unknown model "${selector}". Use provider/model.`);
    await session.setModel(model);
    return toast(`Model: ${selector}`, { model: selector });
  }

  private thinking(session: AgentSession, level: string): SlashResult {
    const levels = session.getAvailableThinkingLevels();
    if (!level) return toast(`Thinking: ${session.thinkingLevel}. Options: ${levels.join(', ')}`);
    const chosen = levels.find(l => l === level);
    if (!chosen) return toast(`This model supports: ${levels.join(', ')}`);
    session.setThinkingLevel(chosen);
    return toast(`Thinking: ${chosen}`);
  }

  private async fresh(session: AgentSession): Promise<SlashResult> {
    if (session.isStreaming) return toast('Still working. Press Esc first, then /new.');
    await this.target.fresh();
    return toast('New session started', { newSession: true });
  }

  private async compact(session: AgentSession, instructions: string): Promise<SlashResult> {
    if (session.isStreaming) return toast('Still working. Press Esc first, then /compact.');
    await session.compact(instructions || undefined);
    return toast('Session compacted');
  }

  private async copy(session: AgentSession): Promise<SlashResult> {
    const last = session.getLastAssistantText();
    if (!last) return toast('Nothing to copy yet.');
    await copyToClipboard(last);
    return toast('Copied the last reply');
  }
}

function sessionInfo(session: AgentSession): string {
  const stats = session.getSessionStats();
  const t = stats.tokens;
  return [
    `Model     ${modelName(session)}  (thinking: ${session.thinkingLevel})`,
    `Session   ${stats.sessionId}`,
    `File      ${stats.sessionFile ?? 'in memory'}`,
    '',
    `Messages  ${stats.userMessages} you · ${stats.assistantMessages} agent · ${stats.toolCalls} tool calls`,
    `Tokens    ${t.input} in · ${t.output} out · ${t.cacheRead} cached · ${t.total} total`,
    `Cost      $${stats.cost.toFixed(4)}`,
  ].join('\n');
}
