import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { defineTool } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { runProofs } from '../proof.js';
import type { Check } from '../types.js';

/** Encode argv as data, so a filename never becomes shell syntax in a re-runnable proof. */
export function commandProof(bin: string, args: string[]): string {
  const data = Buffer.from(JSON.stringify({ bin, args })).toString('base64');
  const script =
    `const p=JSON.parse(Buffer.from('${data}','base64'));` +
    `const r=require('child_process').spawnSync(p.bin,p.args,{stdio:'inherit',windowsHide:true});` +
    `if(r.error)console.error(r.error.message);process.exit(r.status??1)`;
  return `node -e "${script}"`;
}

export function pythonExecutable(cwd: string): string | undefined {
  const candidates = [
    join(cwd, '.venv', 'Scripts', 'python.exe'),
    join(cwd, '.venv', 'bin', 'python'),
    'python',
    'python3',
    ...(process.platform === 'win32' ? ['py'] : []),
  ];
  return candidates.find(
    (bin) =>
      spawnSync(bin, ['--version'], {
        cwd,
        timeout: 3000,
        windowsHide: true,
        stdio: 'ignore',
      }).status === 0,
  );
}

/** Only requested files under the project are inspected; symlinks are resolved before use. */
function projectFile(cwd: string, path: string): string {
  const root = realpathSync(cwd);
  const file = realpathSync(resolve(root, path));
  const rel = relative(root, file);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel)) {
    throw new Error(`File is outside this project: ${path}`);
  }
  return file;
}

/** Real diagnostics plus existing Python tests; no interpreter or dependency is installed silently. */
export async function checkFiles(cwd: string, paths: string[], tests = true, signal?: AbortSignal) {
  const files = paths.map((path) => projectFile(cwd, path));
  const checks: Check[] = [];
  const notes: string[] = [];
  const add = (criterion: string, bin: string, args: string[]): void => {
    checks.push({ criterion, passed: false, proof: commandProof(bin, args) });
  };
  const python = files.filter((file) => extname(file) === '.py');
  if (python.length) {
    const executable = pythonExecutable(cwd);
    if (!executable) notes.push('Python is unavailable. Install Python or configure a project .venv, then retry.');
    else {
      const parse =
        'import ast,pathlib,sys; ' +
        '[ast.parse(pathlib.Path(p).read_text(encoding="utf-8-sig"),filename=p) for p in sys.argv[1:]]; ' +
        'print("Python syntax passed; runtime behavior still requires tests.")';
      add('Python source parses', executable, ['-c', parse, ...python]);
      if (tests) {
        const testDir = join(cwd, 'tests');
        const candidates = [cwd, ...(existsSync(testDir) ? [testDir] : [])].flatMap((dir) =>
          readdirSync(dir)
            .filter((file) => /^test.*\.py$/.test(file))
            .map((file) => join(dir, file)),
        );
        const pytest =
          candidates.some((file) =>
            /(?:^|\n)(?:async )?def test_|(?:import|from) pytest/.test(readFileSync(file, 'utf8')),
          ) ||
          existsSync(join(cwd, 'pytest.ini')) ||
          existsSync(join(cwd, 'conftest.py')) ||
          (existsSync(join(cwd, 'pyproject.toml')) && /pytest/.test(readFileSync(join(cwd, 'pyproject.toml'), 'utf8')));
        const testFiles = readdirSync(cwd).filter((file) => /^test.*\.py$/.test(file));
        if (pytest) add('Python tests pass', executable, ['-m', 'pytest', '-q']);
        else if (existsSync(join(cwd, 'tests')) || testFiles.length) {
          const run =
            'import unittest,sys; s=unittest.defaultTestLoader.discover(sys.argv[1]); ' +
            's.countTestCases() or sys.exit("No tests discovered"); ' +
            'sys.exit(not unittest.TextTestRunner().run(s).wasSuccessful())';
          add('Python tests pass', executable, ['-c', run, existsSync(testDir) ? 'tests' : '.']);
        } else notes.push('No Python tests were found. Syntax checks do not verify runtime behavior.');
      }
    }
  }
  for (const file of files.filter((file) => ['.js', '.mjs', '.cjs'].includes(extname(file)))) {
    add(`${basename(file)} parses`, process.execPath, ['--check', file]);
  }
  if (files.some((file) => ['.ts', '.tsx', '.jsx'].includes(extname(file)))) {
    const compiler = join(cwd, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(compiler) && existsSync(join(cwd, 'tsconfig.json'))) {
      add('Project typecheck passes', process.execPath, [compiler, '--noEmit', '-p', join(cwd, 'tsconfig.json')]);
    } else notes.push('No local TypeScript compiler/tsconfig found. Run the project-specific check with bash.');
  }
  if (!checks.length && !notes.length)
    notes.push('No built-in diagnostic for these files; run the project checks with bash.');
  const results = await runProofs(cwd, checks, signal ? { signal } : {});
  for (const check of results) {
    check.passed = check.ran?.code === 0;
    if (/Ran 0 tests|No tests discovered/.test(check.ran?.tail ?? '')) {
      check.passed = false;
      notes.push('The test runner discovered no tests; runtime behavior remains unverified.');
    }
  }
  return { checks: results, notes };
}

export function checkTool(cwd: string) {
  return defineTool({
    name: 'fade_check',
    label: 'Check project files',
    description:
      'Check Python syntax and existing unittest/pytest tests, JavaScript syntax or local TypeScript types. ' +
      'Returns actual output and replayable proof commands. Syntax alone does not prove runtime behavior. ' +
      'Use bash for other languages and project-specific tests.',
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 30 }),
      tests: Type.Optional(Type.Boolean({ description: 'Run discovered Python tests (default true).' })),
    }),
    execute: async (_id, params, signal) => {
      const result = await checkFiles(cwd, params.paths, params.tests, signal);
      return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
    },
  });
}
