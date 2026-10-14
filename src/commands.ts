import type { AutocompleteItem, AutocompleteProvider } from '@earendil-works/pi-tui';
import type { SlashCommandInfo } from '@earendil-works/pi-coding-agent';

export type CommandSurface = 'split' | 'native' | 'plain';
export type CommandCategory = 'fade' | 'inspection' | 'native' | 'template' | 'skill';
/** Rendering-independent authority for dispatch, registration, discovery and help. */
export interface CommandDefinition {
  name: string;
  description: string;
  aliases: readonly { name: string; surfaces: readonly CommandSurface[]; deprecation?: string }[];
  argumentHint: string;
  surfaces: readonly CommandSurface[];
  category: CommandCategory;
  changesState: boolean;
  opensDialog: boolean;
  available: boolean;
  disabledReason?: string;
  progressLabel?: string;
  argumentCompletions?: (prefix: string) => AutocompleteItem[] | null;
}
const all: readonly CommandSurface[] = ['split', 'native', 'plain'];
const interactive: readonly CommandSurface[] = ['split', 'native'];
function definition(name: string, description: string, category: CommandCategory, argumentHint = '', changesState = false,
  surfaces = all, opensDialog = category === 'inspection'): CommandDefinition {
  return { name, description, aliases: [], argumentHint, surfaces, category, changesState, opensDialog, available: true,
    ...(changesState ? { progressLabel: `Running /${name}` } : {}) };
}
/** Native controls mirror the documented Pi 1.0.4 catalog; getCommands excludes them. */
export const NATIVE_COMMANDS: readonly CommandDefinition[] = [
  definition('settings', 'Open Pi settings', 'native'),
  definition('model', 'Select role conversation model', 'native', '<provider/model>'),
  definition('tree', 'Navigate Pi session tree', 'native'),
  definition('thinking', 'Set thinking level', 'native', '<level>'),
  definition('scoped-models', 'Choose models for cycling', 'native'),
  definition('export', 'Export Pi session', 'native', '[path]'),
  definition('import', 'Import and resume a Pi JSONL session', 'native', '<path>'),
  definition('share', 'Share Pi session via its native control', 'native'),
  definition('bug', 'Pi developer bug-report control', 'native', '<description>'),
  definition('copy', 'Copy last Pi response', 'native'),
  definition('name', 'Set Pi session name', 'native', '<name>'),
  definition('session', 'Inspect Pi session stats', 'native'),
  definition('changelog', 'Inspect Pi changelog', 'native'),
  definition('hotkeys', 'Inspect native shortcuts', 'native'),
  definition('fork', 'Fork a Pi session', 'native'),
  definition('clone', 'Duplicate current Pi session', 'native'),
  definition('trust', 'Set Pi project trust', 'native'),
  definition('login', 'Configure provider authentication', 'native', '[provider]'),
  definition('logout', 'Remove provider authentication', 'native'),
  definition('new', 'Start a conversation session', 'native'),
  definition('compact', 'Compact Pi context', 'native', '[instructions]'),
  definition('resume', 'Select a Pi conversation session', 'native'),
  definition('reload', 'Reload Pi resources', 'native'),
  definition('quit', 'Save and exit Fade', 'native'),
].map(command => ({ ...command, surfaces: command.name === 'quit' ? all : interactive, changesState: true,
  opensDialog: !['copy', 'name', 'export', 'compact', 'reload', 'quit'].includes(command.name) }));

export const FADE_COMMANDS: readonly CommandDefinition[] = [
  definition('builder', 'Inspect Builder or send a durable note', 'inspection', '[message]'),
  definition('companion', 'Talk to Companion explicitly', 'fade', '[message]', true),
  definition('intent', 'Inspect and edit Living Intent', 'inspection'),
  definition('changes', 'Inspect observed workspace changes', 'inspection', '[slice-id]'),
  definition('log', 'Search and page observed execution output', 'inspection', '[query]'),
  definition('status', 'Inspect activity, limits and receipts', 'inspection'),
  definition('inputs', 'Inspect durable input receipts', 'inspection'),
  definition('reports', 'Inspect outcomes, claims and evidence', 'inspection'),
  definition('history', 'Inspect saved conversation', 'inspection'),
  definition('help', 'Search Fade commands and Pi capabilities', 'inspection'),
  definition('pause', 'Pause Builder and retain partial work', 'fade', '', true),
  definition('stop', 'Stop automatic Builder continuation', 'fade', '', true),
  definition('accept-check', 'Record a human inspection result', 'fade', '<slice-id> <check-id> pass|fail <evidence>', true),
  { ...definition('continue', 'Continue paused Builder work', 'fade', '', true), aliases: [
    { name: 'resume', surfaces: ['plain'], deprecation: 'Plain /resume is deprecated; use /continue for Builder. Interactive /resume selects a Pi session.' },
  ] },
  definition('redirect', 'Interrupt Builder and develop new direction', 'fade', '<direction>', true),
  definition('rethink', 'Reconcile intent and implementation discoveries', 'fade', '', true),
  { ...definition('apply-intent', 'Import revision-checked intent edits', 'fade', '', true), aliases: [
    { name: 'reload', surfaces: ['plain'], deprecation: 'Plain /reload imports intent; prefer /apply-intent. Interactive /reload reloads Pi resources.' },
  ] },
  { ...definition('preference', 'Set conversation preference', 'fade', 'design|technical', true), argumentCompletions: prefix =>
    ['design', 'technical'].filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })) },
  definition('retry-input', 'Explicitly retry a saved receipt', 'fade', '<receipt-id>', true),
  definition('edit-input', 'Edit an undelivered receipt', 'fade', '<receipt-id> <text>', true),
  definition('cancel-input', 'Cancel an undelivered receipt', 'fade', '<receipt-id>', true),
  definition('diagnostics', 'Inspect routine resource/update diagnostics', 'inspection', '', false, interactive),
  definition('pi', 'Open native Pi controls; /fade returns', 'native', '', false, interactive),
  definition('fade', 'Return to Fade split workspace', 'fade', '', false, interactive),
  definition('write', 'Compose multiline text; /send or /cancel', 'fade', '', false, ['plain']),
  definition('editor', 'Compose in your configured external editor', 'fade', '', false, ['plain']),
  definition('models', 'List configured Pi models', 'fade', '', false, ['plain']),
  definition('doctor', 'Inspect local readiness and recovery without a provider call', 'inspection'),
  definition('bug-report', 'Preview metadata or export a local file after Builder stops', 'inspection', '[export [relative-path.json]]', true),
];

/** Add discovered Pi resources without overriding Fade/native authority. */
export function commandCatalog(resources: readonly SlashCommandInfo[] = []): readonly CommandDefinition[] {
  const catalog = [...FADE_COMMANDS, ...NATIVE_COMMANDS];
  const names = new Set(catalog.map(command => command.name));
  for (const resource of resources) {
    if (names.has(resource.name)) continue;
    names.add(resource.name);
    catalog.push(definition(resource.name, resource.description ?? `Pi ${resource.source}`, resource.source === 'extension' ? 'native'
      : resource.source === 'prompt' ? 'template' : 'skill', '[arguments]', resource.source !== 'prompt', interactive, resource.source === 'extension'));
  }
  return catalog;
}
export type ParsedInput = { kind: 'text' | 'shell' | 'menu'; original: string; text: string }
  | { kind: 'command'; original: string; text: string; name: string; args: string };
/** A single-line leading command is syntax; multiline prose/code remains ordinary input. */
export function parseInput(original: string): ParsedInput {
  const text = original.trim();
  if (/[\r\n]/.test(text)) return { kind: 'text', original, text: original };
  if (text === '/') return { kind: 'menu', original, text };
  if (text.startsWith('!')) return { kind: 'shell', original, text };
  const match = /^\/([^\s]+)(?:[^\S\r\n]+([\s\S]*))?$/.exec(text);
  if (!match?.[1]) return { kind: 'text', original, text: original };
  // Slice arguments from the untrimmed input so trailing whitespace is retained.
  const source = original.trimStart(); const argumentStart = source.search(/\s/);
  return { kind: 'command', original, text, name: match[1], args: argumentStart < 0 ? '' : source.slice(argumentStart).trimStart() };
}
export type CommandRoute = { kind: 'text' | 'shell' | 'menu'; original: string; text: string }
  | { kind: 'rejected'; original: string; text: string; error: string }
  | { kind: 'command'; original: string; text: string; args: string; command: CommandDefinition; deprecation?: string };

/** Resolve only advertised commands; a typo can never become model input. */
export function routeInput(original: string, surface: CommandSurface, catalog = commandCatalog()): CommandRoute {
  const parsed = parseInput(original);
  if (parsed.kind !== 'command') {
    if (parsed.kind === 'shell' && surface === 'plain') return { ...parsed, kind: 'rejected', error: 'Human shell input requires the interactive Pi surface. Launch Fade in a terminal and use /pi.' };
    return parsed;
  }
  let command = catalog.find(item => item.name === parsed.name && item.surfaces.includes(surface));
  let deprecation: string | undefined;
  if (!command) {
    command = catalog.find(item => item.aliases.some(alias => alias.name === parsed.name && alias.surfaces.includes(surface)));
    deprecation = command?.aliases.find(alias => alias.name === parsed.name && alias.surfaces.includes(surface))?.deprecation;
  }
  if (!command) {
    const unavailable = catalog.find(item => item.name === parsed.name);
    const suggestions = catalog.filter(item => item.surfaces.includes(surface) && (item.name.startsWith(parsed.name.slice(0, 2)) || parsed.name.startsWith(item.name.slice(0, 2)))).slice(0, 3);
    return { kind: 'rejected', original, text: parsed.text, error: unavailable
      ? `/${parsed.name} is unavailable in ${surface}. Use the interactive Pi surface.`
      : `Unknown command /${parsed.name}. ${suggestions.length ? 'Try ' + suggestions.map(item => '/' + item.name).join(', ') + '.' : 'Use /help for commands.'}` };
  }
  if (!command.available) return { kind: 'rejected', original, text: parsed.text, error: `/${parsed.name} is unavailable: ${command.disabledReason ?? 'Not ready.'}` };
  return { kind: 'command', original, text: `/${command.name}${parsed.args ? ' ' + parsed.args : ''}`, args: parsed.args, command, ...(deprecation ? { deprecation } : {}) };
}
/** Help and future completion consume the same surface-specific definitions. */
export function commandHelp(surface: CommandSurface, catalog = commandCatalog()): string {
  return catalog.filter(command => command.surfaces.includes(surface)).map(command =>
    `/${command.name}${command.argumentHint ? ' ' + command.argumentHint : ''} — ${command.description}${command.available ? '' : ' (unavailable: ' + command.disabledReason + ')'}`
    + command.aliases.filter(alias => alias.surfaces.includes(surface)).map(alias => `\n/${alias.name} — ${alias.deprecation ?? `alias for /${command.name}`}`).join('')).join('\n')
    + (surface === 'plain' ? '\n/write: /send submits multiline input; /cancel retains the draft. /continue controls Builder.' :
      '\nTab switches panes when no completion is open. Alt+1/2/3 selects Builder/Companion/Fade.\nEscape closes inspection/completion first, otherwise interrupts the focused role. Companion stays read-only.\n! / !! are explicit human shell operations through Pi after Builder quiescence.\n/pi opens native controls; /fade restores saved panes.');
}

/** Wrap Pi's live provider, retaining native argument/file/resource completion. */
export function fadeAutocomplete(current: AutocompleteProvider, catalog: () => readonly CommandDefinition[]): AutocompleteProvider {
  return {
    ...(current.triggerCharacters ? { triggerCharacters: current.triggerCharacters } : {}),
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const native = await current.getSuggestions(lines, cursorLine, cursorCol, options);
      if (options.signal.aborted) return null;
      const before = (lines[cursorLine] ?? '').slice(0, cursorCol);
      const match = lines.length === 1 ? /^\s*\/([^\s/]*)$/.exec(before) : null;
      const definitions = catalog().filter(command => command.surfaces.includes('split'));
      if (!match) return native;
      const prefix = match[1] ?? '';
      const items = native?.items ?? definitions.filter(command => command.name.startsWith(prefix)).map(command => ({ value: command.name, label: command.name }));
      return { prefix: '/' + prefix, items: items.map(item => {
        const definition = definitions.find(command => command.name === item.value);
        return definition ? { ...item, description: definition.description + (definition.available ? '' : ` · unavailable: ${definition.disabledReason}`) } : item;
      }) };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      // Never erase arguments already typed to the right of a command-name completion.
      const definition = prefix.startsWith('/') ? catalog().find(command => command.name === item.value) : undefined;
      if (definition && !definition.available) return { lines, cursorLine, cursorCol };
      return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion: (...args) => current.shouldTriggerFileCompletion?.(...args) ?? false,
  };
}
