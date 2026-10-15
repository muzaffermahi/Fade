// Real Pi conversation gate in an isolated repository; no project files are modified.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/assemble.js';
import { PiBuilder } from '../src/agents/builder.js';
import { PiCompanion } from '../src/agents/companion.js';
import { createRuntime } from '../src/agents/pi.js';
import { Git } from '../src/git.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const model = process.argv[2] ?? 'opencode-go/deepseek-v4-flash';
  if (!(await runtime.getAvailable()).some(m => `${m.provider}/${m.id}` === model)) throw new Error(`Model unavailable: ${model}`);
  const resume = process.env.FADE_SMOKE_RESUME;
  const cwd = resume ?? mkdtempSync(join(tmpdir(), 'fade-v04-live-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (!resume) {
  git('init', '-q'); git('config', 'user.name', 'Fade Smoke'); git('config', 'user.email', 'smoke@fade.local');
  git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'tiny-cli', version: '1.2.3', scripts: { test: 'node --test' } }));
  writeFileSync(join(cwd, 'cli.cjs'), `console.log('Usage: tiny [--help]');\n`);
  writeFileSync(join(cwd, 'README.md'), '# Tiny CLI\nRun node cli.cjs. Tests use node --test.\n');
  git('add', '-A'); git('commit', '-qm', 'init'); new Git(cwd).excludeFade();
  } else writeFileSync(join(cwd, 'PLAN.md'), '# Plan\n');
  const fade = assemble(cwd, plan => ({ builder: new PiBuilder({ cwd, runtime, model }), companion: new PiCompanion({ cwd, runtime, model, plan }) }));
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 180000;
    while (!check()) {
      if (!fade.view().building && !fade.view().companionBusy && fade.view().reviews.some(r => r.verdict !== 'look')) throw new Error(`Work needs review (${fade.view().builderError ?? 'no checkpoint error'}): ` + JSON.stringify(fade.view().reviews));
      if (Date.now() > deadline) throw new Error('Timed out waiting for conversation');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  };
  let seen = 0;
  fade.onChange(() => {
    const entries = fade.view().companion;
    for (const entry of entries.slice(seen)) if (entry.role !== 'tool') console.log(`${entry.role}: ${entry.text}`);
    seen = entries.length;
  });
  try {
    console.log(`workspace: ${cwd}`); await fade.init(); fade.start();
    if (!resume) {
    fade.sendToCompanion('add a --version flag');
    await until(() => !fade.view().companionBusy && !fade.view().building);
    assert.ok(fade.view().done.length > 0, 'objective work quietly lands after proof');
    assert.match(git('log', '-1', '--format=%s'), /fade:/);
    assert.match(execFileSync(process.execPath, ['cli.cjs', '--version'], { cwd, encoding: 'utf8' }), /1.2.3/);
    assert.ok(fade.view().companion.some(e => e.role === 'companion' && /On it\b/i.test(e.text)));
    assert.ok(fade.view().companion.some(e => e.role === 'landed' && e.text.startsWith('✓')));
    fade.sendToCompanion('undo that');
    await until(() => !fade.view().building);
    assert.doesNotMatch(readFileSync(join(cwd, 'cli.cjs'), 'utf8'), /--version/);
    }
    fade.sendToCompanion('make the help text friendlier');
    await until(() => !fade.view().companionBusy);
    assert.equal(fade.view().building, null, 'a fuzzy ask waits for an answer');
    assert.match(fade.view().companion.findLast(e => e.role === 'companion')?.text ?? '', /\?/, 'a question in words');
    fade.sendToCompanion('the second one');
    await until(() => !fade.view().companionBusy && !fade.view().building);
    assert.ok(fade.view().reviews.some(r => r.verdict === 'look'), 'subjective work waits for the human look');
    fade.sendToCompanion('yes');
    await until(() => !fade.view().companionBusy && !fade.view().reviews.some(r => r.verdict === 'look'));
    console.log(resume ? 'PASS: resumed word choice and human look acceptance.' : 'PASS: version, named proof, undo, word choice and human look acceptance.');
  } finally { await fade.stopBuilder(); await fade.stopCompanion(); fade.dispose(); }
}
main().catch(error => { console.error(String(error)); process.exitCode = 1; });
