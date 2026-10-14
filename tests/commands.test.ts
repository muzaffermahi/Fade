import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { validate } from '../src/contracts.js';
import { FadeApp } from '../src/app.js';
import { Store } from '../src/store.js';
import { commandCatalog, commandHelp, FADE_COMMANDS, NATIVE_COMMANDS, parseInput, routeInput } from '../src/commands.js';

test('G06/G12/G17 F-CONTROL: every catalog command and surface alias resolves to its advertised destination', async () => {
  const catalog = commandCatalog();
  for (const command of catalog) {
    assert.ok(command.description); assert.ok(command.surfaces.length);
    for (const surface of command.surfaces) {
      const route = routeInput('/' + command.name, surface, catalog);
      assert.equal(route.kind, command.available ? 'command' : 'rejected', command.name);
      if (route.kind === 'command') { assert.equal(route.command.name, command.name); assert.equal(route.command.category, command.category); }
      if (route.kind === 'rejected') assert.ok(command.disabledReason && route.error.includes(command.disabledReason));
      assert.ok(commandHelp(surface, catalog).includes('/' + command.name));
    }
    for (const alias of command.aliases) for (const surface of alias.surfaces) {
      const route = routeInput('/' + alias.name, surface, catalog); assert.equal(route.kind, 'command');
      if (route.kind === 'command') { assert.equal(route.command.name, command.name); assert.equal(route.deprecation, alias.deprecation); }
    }
  }
  // Compare against the installed pinned implementation; do not mistake getCommands for this list.
  const loaded: unknown = await import(new URL('core/slash-commands.js', import.meta.resolve('@earendil-works/pi-coding-agent')).href);
  assert.ok(loaded && typeof loaded === 'object' && 'BUILTIN_SLASH_COMMANDS' in loaded);
  const native = validate(Type.Array(Type.Object({ name: Type.String(), description: Type.String(), argumentHint: Type.Optional(Type.String()) })), loaded.BUILTIN_SLASH_COMMANDS);
  assert.deepEqual(NATIVE_COMMANDS.map(item => item.name).sort(), native.map(item => item.name).sort());
});
test('G11/G12 F-CONTROL: parsing preserves original prose and command arguments across whitespace and paste', () => {
  const original = '  \t/builder  keep  two spaces\tand trailing  ';
  const parsed = parseInput(original); assert.equal(parsed.kind, 'command');
  if (parsed.kind === 'command') { assert.equal(parsed.args, 'keep  two spaces\tand trailing  '); assert.equal(parsed.original, original); }
  for (const prose of ['Discuss /pause without executing it', '/path/example\nthis is prose', '```\n/status\n```', '  !shell-like code\nnext line']) {
    const route = routeInput(prose, 'split'); assert.equal(route.kind, 'text'); assert.equal(route.text, prose);
  }
  assert.equal(routeInput('  /status\r\n', 'split').kind, 'command');
  assert.equal(routeInput('  !!echo human shell  ', 'split').kind, 'shell');
  assert.equal(routeInput('  /  ', 'split').kind, 'menu');
  assert.equal(routeInput('!', 'plain').kind, 'rejected');
  const resume = routeInput('/resume', 'split'); assert.equal(resume.kind, 'command');
  if (resume.kind === 'command') assert.equal(resume.command.category, 'native');
  const legacy = routeInput('/resume', 'plain'); assert.equal(legacy.kind, 'command');
  if (legacy.kind === 'command') { assert.equal(legacy.command.name, 'continue'); assert.match(legacy.deprecation ?? '', /deprecated.*\/continue/); }
  const reload = routeInput('/reload', 'plain'); assert.equal(reload.kind, 'command');
  if (reload.kind === 'command') assert.equal(reload.command.name, 'apply-intent');
});
test('G05/G06/G17 F-CONTROL: unknown commands are rejected and discovered resources retain intentional routes', () => {
  const catalog = commandCatalog([
    { name: 'project-review', description: 'Review template', source: 'prompt', sourceInfo: { source: 'project', scope: 'project', origin: 'top-level', path: '/fixture/review.md' } },
    { name: 'skill:review', description: 'Review skill', source: 'skill', sourceInfo: { source: 'project', scope: 'project', origin: 'top-level', path: '/fixture/SKILL.md' } },
    { name: 'custom-control', description: 'Extension dialog', source: 'extension', sourceInfo: { source: 'project', scope: 'project', origin: 'top-level', path: '/fixture/extension.ts' } },
  ]);
  for (const [name, category] of [['project-review', 'template'], ['skill:review', 'skill'], ['custom-control', 'native']] as const) {
    const route = routeInput('/' + name + ' first  second', 'split', catalog); assert.equal(route.kind, 'command');
    if (route.kind === 'command') { assert.equal(route.command.category, category); assert.equal(route.args, 'first  second'); }
    assert.equal(routeInput('/' + name, 'plain', catalog).kind, 'rejected');
  }
  const typo = routeInput('/preferece technical', 'split', catalog); assert.equal(typo.kind, 'rejected');
  if (typo.kind === 'rejected') assert.match(typo.error, /Unknown command.*\/preference/);
  assert.equal(routeInput('/model', 'plain').kind, 'rejected');
  const preference = FADE_COMMANDS.find(item => item.name === 'preference'); assert.ok(preference?.argumentCompletions);
  assert.deepEqual(preference.argumentCompletions('tech')?.map(item => item.value), ['technical']);
});
test('G05/G08 F-CONTROL: application controls reject unknown names and emit actionable errors without provider calls', async () => {
  let calls = 0; const notices: string[] = [];
  const app = new FadeApp(new Store(mkdtempSync(join(tmpdir(), 'fade-command-'))), {}, notice => notices.push(notice.text), () => {}, () => ({
    build: async () => { throw new Error('No implementation authorized'); }, converse: async () => { calls++; return { reply: 'Explore', evidence: [], openQuestions: [], next: null }; }, close() {},
  }));
  try {
    await assert.rejects(app.command('typo', ''), /Unknown command/); assert.equal(calls, 0);
    await app.command('status', ''); assert.ok(notices.some(item => item.includes('No active implementation'))); assert.equal(calls, 0);
    await app.submit('Inspect the plan'); assert.equal(calls, 1);
    await assert.rejects(app.command('preference', 'invalid'), /design or technical/); assert.equal(calls, 1);
    await app.command('preference', 'technical'); assert.ok(notices.includes('Conversation preference: technical'));
  } finally { await app.close(); }
});
