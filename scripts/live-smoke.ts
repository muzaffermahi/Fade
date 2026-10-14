// Real-model smoke test: runs one tiny card through the real PiBuilder in a fresh temp git repo.
// Makes real model calls. Usage: node --import tsx scripts/live-smoke.ts [provider/model]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiBuilder } from '../src/agents/builder.js';
import { createRuntime } from '../src/agents/pi.js';
import { Git } from '../src/git.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  if ((await runtime.getAvailable()).length === 0) {
    console.log('SKIPPED: no models available. Run "fade login" first.');
    return;
  }
  const cwd = mkdtempSync(join(tmpdir(), 'fade-smoke-'));
  const run = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' });
  run('init', '-q');
  run('config', 'user.name', 'Smoke');
  run('config', 'user.email', 'smoke@fade.local');
  writeFileSync(join(cwd, 'README.md'), '# Smoke\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'init');

  new Git(cwd).excludeFade();
  const model = process.argv[2];
  const builder = new PiBuilder({ cwd, runtime, ...(model ? { model } : {}) });
  await builder.init();
  const card = {
    title: 'Create hello.txt',
    state: 'ready' as const,
    body: 'Create hello.txt containing hi. Done when: the file exists',
  };
  const outcome = await builder.build(card, '', event => {
    if (event.type === 'action') console.log(`  ${event.text}`);
  });
  console.log('outcome:', JSON.stringify(outcome));
  console.log('hello.txt exists:', existsSync(join(cwd, 'hello.txt')));
  const git = new Git(cwd);
  console.log('checkpoint:', JSON.stringify(git.hasChanges() ? git.checkpoint('fade: Create hello.txt') : 'no changes'));
  builder.dispose();
}

main().catch((error: unknown) => {
  console.error('FAILED:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
