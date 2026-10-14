#!/usr/bin/env node
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { errorText, type Notice } from './coordinator.js';
import { FadeApp } from './app.js';
import { Store } from './store.js';
import { PiAgents, type PiOptions } from './pi.js';
import { validate, RunLimitSchema } from './contracts.js';
import { commandHelp, routeInput } from './commands.js';
import { terminalText } from './terminal-text.js';

const HELP = `Fade — a tool for the mind\n\n${commandHelp('plain')}\n\nLaunch: Fade [--workspace <directory>] [--idea "your idea"]\nModels: --builder provider/model --companion provider/model\nRun: --run-limit 1..20 (default four). Local trusted code runs with your OS permissions.\n`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
export async function runPlain(): Promise<void> {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  const workspace = resolve(flag('--workspace') ?? process.cwd());
  const initialIdea = flag('--idea');
  const builder = flag('--builder') ?? process.env.FADE_BUILDER_MODEL;
  const companion = flag('--companion') ?? process.env.FADE_COMPANION_MODEL;
  mkdirSync(workspace, { recursive: true });
  const store = new Store(workspace); store.lock();
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let quitting = false, inputEnded = false, composing = false, draft: string[] = [], pending = 0;
  const show = ({ role, text }: Notice) => {
    if (quitting) return;
    if (process.stdout.isTTY) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); }
    const safe = terminalText(text, 500000);
    console.log(`\n${role === 'companion' ? 'Companion' : role === 'builder' ? '  Pi' : 'Fade'}\n${safe}\n`);
    terminal.prompt(true);
  };
  const options: PiOptions = {};
  const limit = flag('--run-limit') ?? process.env.FADE_RUN_LIMIT;
  if (limit !== undefined) options.runLimit = validate(RunLimitSchema, Number(limit));
  if (builder) options.builderModel = builder;
  if (companion) options.companionModel = companion;
  let app: FadeApp;
  try { app = new FadeApp(store, options, show); } catch (error) { store.close(); terminal.close(); throw error; }
  const state = app.coordinator?.state;
  console.log(`\nFade\nA tool for the mind. Think about the future while Pi builds the present.\n\nWorkspace: ${workspace}\n/help for controls. /write for long-form writing.\n`);
  terminal.setPrompt('you › ');
  if (state) {
    console.log('Recovered your project, paused. /continue restarts implementation.\n');
    const last = app.history().filter(m => m.role === 'companion').at(-1);
    if (last) console.log(`Companion\n${last.text}\n`);
  } else if (initialIdea) void app.submit(initialIdea);
  else console.log('What do you want to create? Your first message starts the project.\n');
  const quit = async () => {
    if (quitting) return;
    quitting = true;
    await app.close();
    terminal.close();
  };
  const talk = (text: string) => {
    let acceptedId: string | undefined;
    const failed = (error: unknown) => {
      if (!acceptedId) draft = text.split('\n');
      app.report(acceptedId ? 'uncertain_delivery' : 'acceptance_rejected', 'companion', acceptedId ?? 'plain-input',
        errorText(error) + (acceptedId ? ' Input remains saved; inspect /inputs.' : ' Use /write to recover your draft.'), acceptedId ? ['inputs', 'diagnostics'] : ['edit-draft'], acceptedId);
    };
    try { void app.submit(text, {}, id => { acceptedId = id; }).catch(failed); } catch (error) { failed(error); }
  };
  async function line(input: string): Promise<void> {
    if (quitting) return;
    if (composing) {
      if (input === '/send') { composing = false; terminal.setPrompt('you › '); const text = draft.join('\n'); draft = []; talk(text); }
      else if (input === '/cancel') { composing = false; terminal.setPrompt('you › '); }
      else draft.push(input);
      return;
    }
    const route = routeInput(input, 'plain');
    if (route.kind === 'rejected') { draft = input.split('\n'); app.report('invalid_command', 'companion', 'plain-command', route.error + ' Draft retained; /write recovers it.', ['edit-draft']); return; }
    if (route.kind === 'menu') { console.log(HELP); return; }
    const command = route.text.trim();
    if (!command) return;
    if (route.kind === 'command' && route.deprecation) show({ role: 'system', text: route.deprecation });
    if (command === '/quit') { await quit(); return; }
    if (command === '/help') { console.log(HELP); return; }
    if (command === '/write') { composing = true; terminal.setPrompt('… '); console.log('Write freely. /send submits; /cancel keeps your draft.'); if (draft.length) console.log(draft.join('\n')); return; }
    if (command === '/editor') {
      const editor = process.env.FADE_EDITOR ?? process.env.VISUAL ?? process.env.EDITOR;
      if (!editor) throw new Error('Set FADE_EDITOR to an editor executable (for example notepad.exe). /write is also available.');
      const file = join(store.directory, 'draft.md');
      writeFileSync(file, draft.join('\n'));
      // Editor receives only a local draft file, never shell-interpolated content.
      terminal.pause();
      try {
        await new Promise<void>((resolveEditor, rejectEditor) => {
          const child = spawn(editor, [file], { stdio: 'inherit', shell: false });
          child.once('error', rejectEditor);
          child.once('exit', code => code === 0 ? resolveEditor() : rejectEditor(new Error('Editor failed.')));
        });
      } finally { terminal.resume(); }
      talk(readFileSync(file, 'utf8')); return;
    }

    if (command === '/models') {
      const agents = app.coordinator?.agents;
      if (agents instanceof PiAgents) console.log((await agents.models()).join('\n') || 'No authenticated models. Configure Pi credentials.'); return;
    }
    if (route.kind === 'command') {
      await app.command(route.command.name, route.args); return;
    }
    talk(input);
  }
  let commands = Promise.resolve();
  terminal.on('line', input => {
    pending++;
    commands = commands.then(() => line(input)).catch(error => app.report('invalid_command', 'companion', 'plain-command', errorText(error), ['diagnostics'])).finally(() => { pending--; if (!quitting) terminal.prompt(true); });
  });
  terminal.on('SIGINT', () => { void quit(); });
  process.once('SIGTERM', () => { void quit(); });
  // Piped input may end before async handlers: let accepted conversations finish, then stop.
  terminal.once('close', () => { inputEnded = true; if (!quitting) void (async () => {
    while (pending) await new Promise(resolvePending => setTimeout(resolvePending, 20));
    await app.idle(); await quit();
  })(); });
  terminal.prompt();
}
