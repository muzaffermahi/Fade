// End-to-end Python change through real Fade agents in an isolated repository.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/assemble.js';
import { PiBuilder } from '../src/agents/builder.js';
import { PiCompanion } from '../src/agents/companion.js';
import { createRuntime } from '../src/agents/pi.js';
import { Git } from '../src/git.js';

const cwd = mkdtempSync(join(tmpdir(), 'fade-python-live-'));
const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'Fade Smoke');
git('config', 'user.email', 'smoke@fade.local');
git('config', 'commit.gpgsign', 'false');
git('config', 'core.autocrlf', 'false');
new Git(cwd).excludeFade();
writeFileSync(join(cwd, '.gitignore'), '__pycache__/\n.pytest_cache/\n');
writeFileSync(join(cwd, 'app.py'), 'def add(a, b):\n    return a - b\n');
mkdirSync(join(cwd, 'tests'));
writeFileSync(join(cwd, 'tests', 'test_app.py'),
  'import unittest\nfrom app import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n');
writeFileSync(join(cwd, 'README.md'), '# Arithmetic\nPython project. Run: python -m unittest discover -s tests\n');
git('add', '-A');
git('commit', '-qm', 'init');
const runtime = await createRuntime();
const model = 'opencode-go/deepseek-v4-flash';
const fade = assemble(cwd, plan => ({
  builder: new PiBuilder({ cwd, runtime, model }), companion: new PiCompanion({ cwd, runtime, model, plan }),
}));
let seen = 0;
fade.onChange(() => {
  const entries = fade.view().companion;
  for (const entry of entries.slice(seen)) if (entry.role !== 'tool') console.log(`${entry.role}: ${entry.text}`);
  seen = entries.length;
});
try {
  console.log(`workspace: ${cwd}`);
  await fade.init();
  fade.start();
  fade.sendToCompanion('Fix add(a, b) in app.py to add the arguments so the existing tests pass.');
  const deadline = Date.now() + 240000;
  while (!fade.view().done.length) {
    if (Date.now() > deadline || (!fade.view().building && !fade.view().companionBusy && fade.view().reviews.length)) {
      throw new Error('Python work did not land: ' + JSON.stringify(fade.view()));
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const review = fade.view().landedReviews[0];
  assert.ok(review?.checks?.every(check => check.ran?.code === 0));
  assert.match(readFileSync(join(cwd, 'app.py'), 'utf8'), /a \+ b/);
  assert.ok(fade.view().companion.some(entry => entry.role === 'landed' && /checked|checks passed/.test(entry.text)));
  console.log('PASS: real Python change, independently rerun proof and quiet landing.');
} finally {
  await fade.stopBuilder();
  await fade.stopCompanion();
  fade.dispose();
}
