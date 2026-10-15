import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkFiles, commandProof, pythonExecutable } from '../src/agents/checks.js';
import { runProofs } from '../src/proof.js';

const project = (): string => mkdtempSync(join(tmpdir(), 'fade-checks-'));
const python = pythonExecutable(process.cwd());

test('Python: real syntax errors fail and syntax success does not claim runtime coverage', { skip: !python }, async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'bad.py'), 'def broken(:\n');
  const failed = await checkFiles(cwd, ['bad.py'], false);
  assert.equal(failed.checks[0]?.passed, false);
  assert.match(failed.checks[0]?.ran?.tail ?? '', /SyntaxError/);
  writeFileSync(join(cwd, 'good.py'), 'def run():\n    raise RuntimeError("not tested")\n');
  const parsed = await checkFiles(cwd, ['good.py']);
  assert.equal(parsed.checks[0]?.passed, true);
  assert.match(parsed.notes.join(' '), /runtime behavior/);
});

test('Python: existing unittest exercises runtime behavior and its failure is captured', { skip: !python }, async () => {
  const cwd = project();
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'app.py'), 'def answer():\n    return 41\n');
  writeFileSync(join(cwd, 'tests', 'test_app.py'),
    'import unittest\nfrom app import answer\nclass TestApp(unittest.TestCase):\n    def test_answer(self): self.assertEqual(answer(), 42)\n');
  const result = await checkFiles(cwd, ['app.py']);
  assert.equal(result.checks[0]?.passed, true);
  assert.equal(result.checks[1]?.passed, false);
  assert.match(result.checks[1]?.ran?.tail ?? '', /41 != 42/);
  const repeated = await runProofs(cwd, result.checks);
  assert.equal(repeated[1]?.ran?.code, 1, 'Fade can rerun the exact same check');
});

test('Python: an empty test directory does not count as verified runtime behavior', { skip: !python }, async () => {
  const cwd = project();
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'app.py'), 'value = 1\n');
  const result = await checkFiles(cwd, ['app.py']);
  assert.equal(result.checks[1]?.passed, false);
  assert.match(result.notes.join(' '), /no tests/);
});

test('diagnostics: real JavaScript and TypeScript failures return nonzero status', async () => {
  const cwd = project();
  writeFileSync(join(cwd, 'bad.cjs'), 'const = ;');
  assert.equal((await checkFiles(cwd, ['bad.cjs'])).checks[0]?.passed, false);
  symlinkSync(join(process.cwd(), 'node_modules'), join(cwd, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(cwd, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, types: [], skipLibCheck: true }, files: ['bad.ts'] }));
  writeFileSync(join(cwd, 'bad.ts'), 'const value: string = 1;');
  const result = await checkFiles(cwd, ['bad.ts']);
  assert.equal(result.checks[0]?.passed, false);
  assert.match(result.checks[0]?.ran?.tail ?? '', /not assignable/);
});

test('diagnostics: path escape is rejected and shell-shaped argv remains data', async () => {
  const cwd = project();
  const outside = join(project(), 'outside.js');
  writeFileSync(outside, 'console.log(1)');
  await assert.rejects(checkFiles(cwd, [outside]), /outside this project/);
  const file = 'odd;name$.cjs';
  writeFileSync(join(cwd, file), 'console.log("ok")');
  assert.equal((await checkFiles(cwd, [file])).checks[0]?.passed, true);
  const [result] = await runProofs(cwd, [{ criterion: 'argv is literal', passed: true,
    proof: commandProof(process.execPath, ['-e', 'if(process.argv[1]!=="; touch injected")process.exit(1)', '; touch injected']) }]);
  assert.equal(result?.ran?.code, 0);
  assert.equal(existsSync(join(cwd, 'injected')), false);
});

test('Python: pytest functions are discovered without a pytest.ini', { skip: !python }, async () => {
  const cwd = project();
  mkdirSync(join(cwd, 'tests'));
  writeFileSync(join(cwd, 'app.py'), 'value = 1\n');
  writeFileSync(join(cwd, 'tests', 'test_app.py'), 'def test_behavior():\n    assert 1 == 2\n');
  const result = await checkFiles(cwd, ['app.py']);
  assert.equal(result.checks[1]?.passed, false);
  assert.match(result.checks[1]?.ran?.tail ?? '', /assert 1 == 2|No module named pytest/);
});
