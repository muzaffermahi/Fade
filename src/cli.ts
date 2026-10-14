#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { FakeBuilder, FakeCompanion } from './agents/fake.js';
import { PiBuilder } from './agents/builder.js';
import { PiCompanion } from './agents/companion.js';
import { createRuntime } from './agents/pi.js';
import { createDemoWorkspace } from './demo.js';
import { Git } from './git.js';
import { assemble } from './assemble.js';
import { startUi } from './ui/app.js';

const VERSION = '0.1.0';
const HELP = `Fade: plan the next thing while AI builds this one.

  fade                      run in the current directory
  fade --demo               try the UI in a temp folder with fake agents (no API calls)
  fade login                connect a model provider (uses Pi)
  fade --builder <p/m>      Builder model, e.g. anthropic/claude-sonnet-4-5
  fade --companion <p/m>    Companion model
  fade --help | --version
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
  console.log('Type /login, pick a provider, then /quit.');
  let cliPath: string | undefined;
  try {
    const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
    const candidate = join(dirname(entry), '..', 'bundle', 'cli.js');
    if (existsSync(candidate)) cliPath = candidate;
  } catch {
    cliPath = undefined;
  }
  if (!cliPath) {
    console.log('Could not find Pi here. Run: npx @earendil-works/pi-coding-agent');
    process.exit(1);
  }
  const result = spawnSync(process.execPath, [cliPath], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

async function ask(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(question)).trim().toLowerCase();
  rl.close();
  return answer === '' || answer.startsWith('y');
}

interface Config {
  builder?: string;
  companion?: string;
}

function readConfig(cwd: string): Config {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(cwd, '.fade', 'config.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null) return {};
    const config: Config = {};
    if ('builder' in raw && typeof raw.builder === 'string') config.builder = raw.builder;
    if ('companion' in raw && typeof raw.companion === 'string') config.companion = raw.companion;
    return config;
  } catch {
    return {};
  }
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
    builder: new PiBuilder({ cwd, runtime, ...(builderModel ? { model: builderModel } : {}) }),
    companion: new PiCompanion({ cwd, runtime, plan, ...(companionModel ? { model: companionModel } : {}) }),
  }));
  await startUi(fade, {
    cwd, branch: git.branch(), builderModel: builderModel ?? 'default', companionModel: companionModel ?? 'default',
  });
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
