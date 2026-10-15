// Live checks in isolated temporary repositories. Modes: web, python, conversation, all.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assemble } from '../src/assemble.js';
import { BUILDER_TOOLS, PiBuilder } from '../src/agents/builder.js';
import { COMPANION_TOOLS, PiCompanion } from '../src/agents/companion.js';
import { createRuntime, loader } from '../src/agents/pi.js';
import { Git } from '../src/git.js';
import { SessionManager, createAgentSession } from '@earendil-works/pi-coding-agent';
import { checkTool } from '../src/agents/checks.js';
async function conversation(model: string, builderModel: string): Promise<void> {
  const runtime = await createRuntime();
  if (!(await runtime.getAvailable()).some((m) => `${m.provider}/${m.id}` === model))
    throw new Error(`Model unavailable: ${model}`);
  const resume = process.env.FADE_SMOKE_RESUME;
  const cwd = resume ?? mkdtempSync(join(tmpdir(), 'fade-v04-live-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (!resume) {
    git('init', '-q');
    git('config', 'user.name', 'Fade Smoke');
    git('config', 'user.email', 'smoke@fade.local');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(
      join(cwd, 'package.json'),
      JSON.stringify({ name: 'tiny-cli', version: '1.2.3', scripts: { test: 'node --test' } }),
    );
    writeFileSync(join(cwd, 'cli.cjs'), `console.log('Usage: tiny [--help]');\n`);
    writeFileSync(join(cwd, 'README.md'), '# Tiny CLI\nRun node cli.cjs. Tests use node --test.\n');
    git('add', '-A');
    git('commit', '-qm', 'init');
    new Git(cwd).excludeFade();
  } else writeFileSync(join(cwd, 'PLAN.md'), '# Plan\n');
  const fade = assemble(cwd, (plan) => ({
    builder: new PiBuilder({ cwd, runtime, model: builderModel }),
    companion: new PiCompanion({ cwd, runtime, model, plan }),
  }));
  const until = async (check: () => boolean): Promise<void> => {
    const deadline = Date.now() + 180000;
    while (!check()) {
      if (!fade.view().building && !fade.view().companionBusy && fade.view().reviews.some((r) => r.verdict !== 'look'))
        throw new Error(
          `Work needs review (${fade.view().builderError ?? 'no checkpoint error'}): ` +
            JSON.stringify(fade.view().reviews),
        );
      if (Date.now() > deadline) throw new Error('Timed out waiting for conversation');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
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
    if (!resume) {
      fade.sendToCompanion('add a --version flag');
      await until(() => !fade.view().companionBusy && !fade.view().building);
      assert.ok(fade.view().done.length > 0, 'objective work quietly lands after proof');
      assert.match(git('log', '-1', '--format=%s'), /fade:/);
      assert.match(execFileSync(process.execPath, ['cli.cjs', '--version'], { cwd, encoding: 'utf8' }), /1.2.3/);
      assert.ok(fade.view().companion.some((e) => e.role === 'landed' && /On it:/i.test(e.text)));
      assert.ok(fade.view().companion.some((e) => e.role === 'landed' && e.text.startsWith('✓')));
      fade.sendToCompanion('undo that');
      await until(() => !fade.view().building);
      assert.doesNotMatch(readFileSync(join(cwd, 'cli.cjs'), 'utf8'), /--version/);
    }
    fade.sendToCompanion('make the help text friendlier');
    await until(() => !fade.view().companionBusy);
    assert.equal(fade.view().building, null, 'a fuzzy ask waits for an answer');
    assert.match(
      fade.view().companion.findLast((e) => e.role === 'companion')?.text ?? '',
      /\?|pick one|choose|which/i,
      'a direction question in words',
    );
    fade.sendToCompanion('the second one');
    await until(() => !fade.view().companionBusy && !fade.view().building);
    assert.ok(
      fade.view().reviews.some((r) => r.verdict === 'look'),
      'subjective work waits for the human look',
    );
    fade.sendToCompanion('yes');
    await until(() => !fade.view().companionBusy && !fade.view().reviews.some((r) => r.verdict === 'look'));
    console.log(
      resume
        ? 'PASS: resumed word choice and human look acceptance.'
        : 'PASS: version, named proof, undo, word choice and human look acceptance.',
    );
  } finally {
    await fade.stopBuilder();
    await fade.stopCompanion();
    fade.dispose();
  }
}
async function web(): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'fade-capabilities-'));
  const runtime = await createRuntime();
  for (const role of ['builder', 'companion'] as const) {
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(cwd),
      tools: role === 'builder' ? BUILDER_TOOLS : COMPANION_TOOLS,
      ...(role === 'companion' ? { excludeTools: ['mcp__*', 'codemode', 'tool_search'] } : {}),
      customTools: role === 'builder' ? [checkTool(cwd)] : [],
      resourceLoader: await loader(cwd, 'Use tools for the requested check.', role === 'builder'),
    });
    try {
      await session.bindExtensions({});
      const activate = session.agent.state.tools.find((tool) => tool.name === 'web_enable');
      if (activate) await activate.execute('enable-web', {}, AbortSignal.timeout(60000));
      const tools = session.getActiveToolNames();
      console.log(`${role}: ${tools.join(', ')}`);
      for (const name of ['web_search', 'fetch_content', 'get_search_content']) assert.ok(tools.includes(name), name);
      if (role === 'companion') {
        assert.ok(
          !tools.some(
            (name) => ['bash', 'write', 'edit', 'codemode', 'tool_search'].includes(name) || name.startsWith('mcp__'),
          ),
        );
      } else {
        assert.ok(tools.includes('fade_check'));
        assert.ok(tools.includes('tool_search'));
        assert.ok(tools.includes('codemode'));
        const fetch = session.agent.state.tools.find((tool) => tool.name === 'fetch_content');
        assert.ok(fetch);
        const fetched = await fetch.execute(
          'fetch-docs',
          { url: 'https://docs.python.org/3/library/unittest.html' },
          AbortSignal.timeout(60000),
        );
        const text = fetched.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        assert.match(text, /TestCase/);
        assert.doesNotMatch(text, /Error fetching|Fetch failed|No content/i);
        console.log(`fetch: ${text.slice(0, 300)}`);
        const search = session.agent.state.tools.find((tool) => tool.name === 'web_search');
        assert.ok(search);
        const found = await search.execute(
          'search-docs',
          { query: 'site:docs.python.org unittest discover', numResults: 3, workflow: 'none' },
          AbortSignal.timeout(60000),
        );
        const results = found.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n');
        console.log(`search: ${results.slice(0, 1200)}`);
        assert.match(results, /https?:\/\/[^\s]*python\.org/);
      }
    } finally {
      session.dispose();
    }
  }
  console.log('PASS: web search/fetch, Builder diagnostics and read-only Companion tool boundary.');
}

async function python(model: string, builderModel: string): Promise<void> {
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
  writeFileSync(
    join(cwd, 'tests', 'test_app.py'),
    'import unittest\nfrom app import add\nclass TestAdd(unittest.TestCase):\n    def test_add(self): self.assertEqual(add(2, 3), 5)\n',
  );
  writeFileSync(join(cwd, 'README.md'), '# Arithmetic\nPython project. Run: python -m unittest discover -s tests\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  const runtime = await createRuntime();
  const fade = assemble(cwd, (plan) => ({
    builder: new PiBuilder({ cwd, runtime, model: builderModel }),
    companion: new PiCompanion({ cwd, runtime, model, plan }),
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
      if (
        Date.now() > deadline ||
        (!fade.view().building && !fade.view().companionBusy && fade.view().reviews.length)
      ) {
        throw new Error('Python work did not land: ' + JSON.stringify(fade.view()));
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const review = fade.view().landedReviews[0];
    assert.ok(review?.checks?.every((check) => check.ran?.code === 0));
    assert.match(readFileSync(join(cwd, 'app.py'), 'utf8'), /a \+ b/);
    assert.ok(
      fade.view().companion.some((entry) => entry.role === 'landed' && /checked|checks passed/.test(entry.text)),
    );
    console.log('PASS: real Python change, independently rerun proof and quiet landing.');
  } finally {
    await fade.stopBuilder();
    await fade.stopCompanion();
    fade.dispose();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2] ?? 'conversation';
  const model = process.argv[3] ?? 'opencode-go/kimi-k3';
  const builderModel = process.argv[4] ?? model;
  if (!['web', 'python', 'conversation', 'all'].includes(mode))
    throw new Error('Use web, python, conversation or all.');
  if (mode === 'web' || mode === 'all') await web();
  if (mode === 'python' || mode === 'all') await python(model, builderModel);
  if (mode === 'conversation' || mode === 'all') await conversation(model, builderModel);
}
main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
