#!/usr/bin/env node
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Store } from './store.js';
import { runTui } from './tui.js';
import { runPlain } from './plain.js';
import type { PiOptions } from './pi.js';
import { validate, RunLimitSchema } from './contracts.js';
import { commandHelp } from './commands.js';

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return value;
}
async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Fade — a tool for the mind\n\nBuilder implements. Companion explores read-only. Fade combines both.\n\nFade [--workspace <directory>] [--idea "your idea"]\n     [--builder provider/model] [--companion provider/model]\n     [--run-limit 1..20] [--plain] (line-based input for scripts)\n\nTab switches panes; Alt+1/2/3 selects Builder/Companion/Fade mode.\n/pi opens native controls; /fade returns. /intent /changes /pause /help.\nThe launch directory is your workspace.');
    console.log('\n' + commandHelp(process.argv.includes('--plain') ? 'plain' : 'split'));
    return;
  }
  if (process.argv.includes('--plain') || !process.stdin.isTTY || !process.stdout.isTTY) { await runPlain(); return; }
  const workspace = resolve(flag('--workspace') ?? process.cwd());
  mkdirSync(workspace, { recursive: true });
  const options: PiOptions = {};
  const limit = flag('--run-limit') ?? process.env.FADE_RUN_LIMIT;
  if (limit !== undefined) options.runLimit = validate(RunLimitSchema, Number(limit));
  const builder = flag('--builder') ?? process.env.FADE_BUILDER_MODEL;
  const companion = flag('--companion') ?? process.env.FADE_COMPANION_MODEL;
  if (builder) options.builderModel = builder;
  if (companion) options.companionModel = companion;
  const store = new Store(workspace); store.lock();
  try { await runTui(store, options, flag('--idea')); } finally { store.close(); }
}
main().catch(error => { console.error(`Fade: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
