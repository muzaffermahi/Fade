// Lending the terminal to another program (Pi's own screens, or a step's try command) and taking it back.
// The child runs asynchronously so a Builder that's mid-step keeps working; Fade just stops drawing meanwhile.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { c } from './theme.js';

function run(command: string, args: string[], cwd: string, shell: boolean): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell });
    child.on('error', () => resolve(1));
    child.on('exit', code => resolve(code ?? 0));
  });
}

async function waitForEnter(message: string): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(message);
  } catch {
    // stdin closed: nothing to wait for.
  } finally {
    rl.close();
  }
}

/** Runs Pi's CLI with `args` in this terminal until the human quits it. */
export async function runPi(cliPath: string, args: string[], cwd: string, intro: string): Promise<void> {
  process.stdout.write(`\n${c.mint('fade')} ${intro}\n\n`);
  await run(process.execPath, [cliPath, ...args], cwd, false);
}

/** Runs a step's try command through the shell, then waits so its output can be read. */
export async function runTryCommand(command: string, cwd: string): Promise<number> {
  process.stdout.write(`\n${c.mint('fade')} ${c.muted('trying:')} ${command}\n\n`);
  const code = await run(command, [], cwd, true);
  const status = code === 0 ? c.mint('✓ finished') : c.rose(`✗ exited with ${code}`);
  await waitForEnter(`\n${status}  ${c.muted('press Enter to return to Fade')} `);
  return code;
}
