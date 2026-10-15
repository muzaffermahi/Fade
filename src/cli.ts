#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { FakeBuilder, FakeCompanion } from './agents/fake.js';
import { PiBuilder } from './agents/builder.js';
import { PiCompanion } from './agents/companion.js';
import { createRuntime, piCliPath } from './agents/pi.js';
import { readConfig, saveModelChoice } from './config.js';
import { createDemoWorkspace } from './demo.js';
import { Git } from './git.js';
import { assemble } from './assemble.js';
import { startUi } from './ui/start.js';

const VERSION = '0.2.0';
const HELP = `Fade: get your flow back. You navigate, AI drives.

  fade                      run in the current directory
  fade --demo               try it in a temp folder with fake agents (no API calls, no key)
  fade login                connect a model provider
  fade --builder <p/m>      Builder model (provider/model-id)
  fade --companion <p/m>    Companion model, e.g. a local one: ollama/<model>
  fade --help | --version

Inside Fade, /model in either pane switches that agent's model and remembers it.
`;

interface Args {
  demo: boolean;
  login: boolean;
  help: boolean;
  version: boolean;
  builder?: string;
  companion?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { demo: false, login: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--demo') args.demo = true;
    else if (arg === 'login') args.login = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--version' || arg === '-v') args.version = true;
    else if (arg === '--builder' && argv[i + 1]) args.builder = argv[++i] as string;
    else if (arg === '--companion' && argv[i + 1]) args.companion = argv[++i] as string;
  }
  return args;
}

function login(): never {
  const cliPath = piCliPath();
  if (!cliPath) {
    console.log('Could not find the login tool. Run: npx @earendil-works/pi-coding-agent, then /login there.');
    process.exit(1);
  }
  console.log('Type /login, pick a provider, then /quit to come back.');
  const result = spawnSync(process.execPath, [cliPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer.startsWith('y');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) return void console.log(HELP);
  if (args.version) return void console.log(VERSION);
  if (args.login) login();

  if (args.demo) {
    const cwd = createDemoWorkspace();
    const fade = assemble(cwd, plan => ({ builder: new FakeBuilder(cwd), companion: new FakeCompanion(plan) }));
    await startUi(fade, { cwd, branch: new Git(cwd).branch(), builderModel: 'demo', companionModel: 'demo' });
    return;
  }

  const cwd = realpathSync(process.cwd());
  const git = new Git(cwd);
  if (!git.isRepo()) {
    if (!(await ask('Fade uses git to checkpoint each card. Initialize a repo here? (Y/n) '))) {
      console.log('Fade needs git to checkpoint and undo work. Run `git init` yourself when you are ready.');
      process.exit(1);
    }
    git.init();
  }
  git.excludeFade();

  const runtime = await createRuntime();
  if ((await runtime.getAvailable()).length === 0) {
    console.log('No models available yet. Run "fade login" to connect a provider (it uses Pi), then run fade again.');
    process.exit(1);
  }
  const config = readConfig(cwd);
  const builderModel = args.builder ?? config.builder;
  const companionModel = args.companion ?? config.companion;
  const fade = assemble(cwd, plan => ({
    builder: new PiBuilder({
      cwd, runtime, ...(builderModel ? { model: builderModel } : {}),
      onModelChange: selector => saveModelChoice(cwd, 'builder', selector),
    }),
    companion: new PiCompanion({
      cwd, runtime, plan, ...(companionModel ? { model: companionModel } : {}),
      onModelChange: selector => saveModelChoice(cwd, 'companion', selector),
    }),
  }));
  await startUi(fade, {
    cwd, branch: git.branch(), builderModel: builderModel ?? 'default', companionModel: companionModel ?? 'default',
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
