#!/usr/bin/env node
import { createInterface, clearLine, cursorTo } from 'node:readline';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Coordinator, errorText, type Notice } from './coordinator.js';
import { Store, renderIntent } from './store.js';
import { PiAgents, type PiOptions } from './pi.js';

const HELP = `Fade — a tool for the mind

Write to the Companion while Pi builds. No minimum length, no tickets.

  /write               Compose across lines; /send submits, /cancel keeps silence
  /editor              Write in your configured editor (FADE_EDITOR or VISUAL)
  /status              Present, future, and recent outcomes
  /intent              Read Living Intent and see its editable JSON path
  /reload              Import your edited intent-edit.json, with a revision check
  /rethink             Reconcile discoveries or retry a failed conversation
  /pause /stop /resume Control the Builder; conversation stays available
  /redirect <thought>  Explicitly interrupt and revise direction
  /log                 Recent real Pi execution events
  /history             Your conversation
  /models              Available Pi provider/model IDs
  /preference design|technical
  /allow <id> /deny <id> Consent to a specific nonroutine shell command
  /quit                Save and leave

Launch: Fade [--workspace <directory>] [--idea "your idea"]
The current directory is your workspace by default. Launch there again to resume.
Models: --builder provider/model --companion provider/model
Only local trusted code should be executed. Pi shell commands and generated code
run with your OS permissions; Fade's path guards are not a shell sandbox.
`;

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
async function main(): Promise<void> {
  if (process.argv.includes('--help')) { console.log(HELP); return; }
  const workspace = resolve(flag('--workspace') ?? process.cwd());
  const initialIdea = flag('--idea');
  const builder = flag('--builder') ?? process.env.FADE_BUILDER_MODEL;
  const companion = flag('--companion') ?? process.env.FADE_COMPANION_MODEL;
  mkdirSync(workspace, { recursive: true });
  const store = new Store(workspace); store.lock();
  let state;
  try { state = store.load(); } catch (error) { store.close(); throw error; }
  const terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY) });
  let quitting = false, inputEnded = false, composing = false, draft: string[] = [], pending = 0;
  let coordinator: Coordinator | undefined;
  const permissions = new Map<string, (allowed: boolean) => void>();
  const show = ({ role, text }: Notice) => {
    if (quitting) return;
    if (process.stdout.isTTY) { clearLine(process.stdout, 0); cursorTo(process.stdout, 0); }
    const safe = text.replace(/[\u001b\u0000-\u0008\u000b-\u001f\u007f]/g, '');
    console.log(`\n${role === 'companion' ? 'Companion' : role === 'builder' ? '  Pi' : 'Fade'}\n${safe}\n`);
    terminal.prompt(true);
  };
  const options: PiOptions = { approve: (command, signal) => new Promise(resolveApproval => {
    if (inputEnded || quitting) { resolveApproval(false); return; }
    const id = randomUUID().slice(0, 8);
    const finish = (allowed: boolean) => { permissions.delete(id); signal?.removeEventListener('abort', abort); resolveApproval(allowed); };
    const abort = () => finish(false);
    if (signal?.aborted) { finish(false); return; }
    permissions.set(id, finish); signal?.addEventListener('abort', abort, { once: true });
    show({ role: 'system', text: `Pi requests a nonroutine command:\n${command}\nIt runs with your OS permissions. /allow ${id} or /deny ${id}` });
  }) };
  if (builder) options.builderModel = builder;
  if (companion) options.companionModel = companion;
  const initialize = (idea: string) => {
    if (!idea.trim()) throw new Error('Start with something you want to create.');
    state = Coordinator.initial(workspace, idea);
    const agents = new PiAgents(store, state, options);
    coordinator = new Coordinator(state, store, agents, show);
    store.save(state); coordinator.start();
    void coordinator.talk(idea);
  };
  console.log(`\nFade\nA tool for the mind. Think about the future while Pi builds the present.\n\nWorkspace: ${workspace}\n/help for controls. /write for long-form writing.\n`);
  terminal.setPrompt('you › ');
  if (state) {
    coordinator = new Coordinator(state, store, new PiAgents(store, state, options), show);
    coordinator.recover();
    console.log('Recovered your project, paused. /resume restarts implementation.\n');
    const last = state.conversation.filter(m => m.role === 'companion').at(-1);
    if (last) console.log(`Companion\n${last.text}\n`);
  } else if (initialIdea) initialize(initialIdea);
  else console.log('What do you want to create? Your first message starts the project.\n');
  const quit = async () => {
    if (quitting) return;
    quitting = true; for (const answer of permissions.values()) answer(false);
    if (coordinator) await coordinator.close(); else store.close();
    terminal.close();
  };
  const talk = (text: string) => {
    if (!coordinator) initialize(text);
    else void coordinator.talk(text).catch(error => {
      draft = text.split('\n'); show({ role: 'system', text: errorText(error) + ' Use /write to recover your draft.' });
    });
  };
  async function line(input: string): Promise<void> {
    if (quitting) return;
    if (composing) {
      if (input === '/send') { composing = false; terminal.setPrompt('you › '); const text = draft.join('\n'); draft = []; talk(text); }
      else if (input === '/cancel') { composing = false; terminal.setPrompt('you › '); }
      else draft.push(input);
      return;
    }
    const command = input.trim();
    if (!command) return;
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
    if (command.startsWith('/allow ') || command.startsWith('/deny ')) {
      const id = command.split(' ')[1] ?? '', answer = permissions.get(id);
      if (!answer) throw new Error('No pending command with that id.');
      answer(command.startsWith('/allow ')); return;
    }
    if (!coordinator) { if (command.startsWith('/')) throw new Error('Start a project with your idea first.'); talk(input); return; }
    const c = coordinator;
    if (command === '/pause' || command === '/stop') { await c.pause(command === '/stop'); return; }
    if (command === '/resume') { c.resume(); return; }
    if (command === '/intent') { console.log(renderIntent(c.state)); console.log(`Edit ${store.prepareIntentEdit(c.state)}, then /reload.`); return; }
    if (command === '/reload') { c.editIntent(store.readIntent()); return; }
    if (command === '/rethink') { talk('Reconcile our latest intent, conversation, and implementation discoveries. Preserve what I have said; develop the next useful slice only if it is sufficiently clear.'); return; }
    if (command.startsWith('/redirect ')) { await c.redirect(command.slice(10)); return; }
    if (command === '/status') {
      console.log(`${c.state.mode}; ${c.state.remainingSlices} slices remaining in this run\n` + c.state.slices.slice(-8).map(s => `${s.status} · ${s.plan.title}\n${s.result?.summary ?? s.plan.goal}`).join('\n\n')); return;
    }
    if (command === '/history') { console.log(c.state.conversation.map(m => `${m.role}\n${m.text}\n`).join('\n')); return; }
    if (command === '/log') {
      try { console.log(readFileSync(join(store.directory, 'builder-events.jsonl'), 'utf8').trim().split('\n').slice(-20).join('\n')); }
      catch { console.log('No execution events yet.'); } return;
    }
    if (command === '/models') {
      if (c.agents instanceof PiAgents) console.log((await c.agents.models()).join('\n') || 'No authenticated models. Configure Pi credentials.'); return;
    }
    if (command.startsWith('/preference ')) {
      const value = command.slice(12);
      if (value !== 'design' && value !== 'technical') throw new Error('Use /preference design or technical.');
      c.state.preference = value; store.save(c.state); console.log(`Conversation preference: ${value}`); return;
    }
    if (command.startsWith('/')) throw new Error('Unknown command. /help lists controls.');
    talk(input);
  }
  terminal.on('line', input => {
    pending++;
    void line(input).catch(error => show({ role: 'system', text: errorText(error) })).finally(() => { pending--; if (!quitting) terminal.prompt(true); });
  });
  terminal.on('SIGINT', () => { void quit(); });
  process.once('SIGTERM', () => { void quit(); });
  // Piped input may end before async handlers: let accepted conversations finish, then stop.
  terminal.once('close', () => { inputEnded = true; for (const answer of permissions.values()) answer(false); if (!quitting) void (async () => {
    while (pending) await new Promise(resolvePending => setTimeout(resolvePending, 20));
    await coordinator?.idle(); await quit();
  })(); });
  terminal.prompt();
}
main().catch(error => { console.error(`Fade: ${errorText(error)}`); process.exitCode = 1; });
