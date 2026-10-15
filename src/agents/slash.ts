import { copyToClipboard, type AgentSession, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AutocompleteItem, SlashCommand } from '@earendil-works/pi-tui';
import type { SlashHost, SlashResult } from '../types.js';
import { errorMessage } from './pi.js';

/**
 * Pi commands that need Pi's own screens (pickers, trees, menus, logins).
 * Fade hands the terminal to Pi on this agent's session and takes it back when you /quit.
 */
const HANDOFF: Record<string, string> = {
  login: 'Connect a model provider',
  logout: 'Remove a provider login',
  settings: 'Pi settings',
  'scoped-models': 'Choose models for cycling',
  tree: 'Browse and branch this session',
  resume: 'Switch to another session',
  fork: 'Fork this session',
  clone: 'Duplicate this session',
  import: 'Import a session file',
  share: 'Share this session',
  trust: 'Project trust settings',
  changelog: "Pi's changelog",
  bug: 'Report a Pi bug',
};

export interface SlashTarget {
  session(): AgentSession | undefined;
  runtime: ModelRuntime;
  /** Where this agent keeps its sessions, so Pi's /resume and /tree see the same ones. */
  sessionDir: string;
  /** Replace the agent's session with a brand-new one. */
  fresh(): Promise<void>;
  /** Reload the agent's latest session from disk, after Pi changed it. */
  reopen(): Promise<void>;
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
        name: 'model', description: 'Switch model (no argument opens a picker)', argumentHint: '[provider/model]',
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
      { name: 'name', description: 'Name this session', argumentHint: '<name>' },
      { name: 'export', description: 'Export this session to HTML' },
      { name: 'copy', description: 'Copy the last reply to the clipboard' },
      { name: 'reload', description: 'Reload extensions, skills, prompts and context files' },
      ...Object.entries(HANDOFF).map(([name, description]) => ({ name, description: `${description} (opens Pi)` })),
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
      case 'name': return this.name(session, args);
      case 'export': return toast(`Exported to ${await session.exportToHtml()}`);
      case 'copy': return this.copy(session);
      case 'reload':
        await session.reload();
        return toast('Reloaded');
    }
    if (name in HANDOFF) return this.handoff(session, name);
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

  private handoff(session: AgentSession, name: string): SlashResult {
    if (session.isStreaming) return toast(`Still working. Press Esc first, then /${name}.`);
    const file = session.sessionManager.getSessionFile();
    const args = ['--session-dir', this.target.sessionDir, ...(file ? ['--session', file] : [])];
    return { kind: 'handoff', command: name, args, reopen: () => this.target.reopen() };
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

  private name(session: AgentSession, name: string): SlashResult {
    if (!name) return toast('Type /name and the new name.');
    session.setSessionName(name);
    return toast(`Session named "${name}"`);
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
