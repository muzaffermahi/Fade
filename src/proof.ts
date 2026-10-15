import { spawn } from 'node:child_process';
import type { Check } from './types.js';

interface ProofOptions {
  timeoutMs?: number;
  totalMs?: number;
  sha?: string;
  signal?: AbortSignal;
}

function run(cwd: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<NonNullable<Check['ran']>> {
  return new Promise(resolve => {
    const started = Date.now();
    let tail = '';
    let interrupted = '';
    const child = spawn(command, {
      cwd, shell: true, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const capture = (chunk: Buffer): void => {
      tail = (tail + chunk.toString()).split('\n').slice(-20).join('\n').slice(-16000);
    };
    child.stdout.on('data', capture);
    child.stderr.on('data', capture);
    const kill = (reason: string): void => {
      interrupted = reason;
      if (!child.pid) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => child.kill());
        killer.on('close', code => { if (code !== 0) child.kill(); });
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(() => kill('Timed out'), timeoutMs);
    const abort = (): void => kill('Stopped');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const finish = (code: number, error = ''): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, tail: [tail.trimEnd(), interrupted, error].filter(Boolean).join('\n'), ms: Date.now() - started });
    };
    child.on('error', error => finish(-1, error.message));
    child.on('close', code => finish(interrupted ? -1 : code ?? -1));
  });
}

/** Re-run proofs sequentially, with bounded time/output and no trust in supplied run results. */
export async function runProofs(cwd: string, checks: Check[], options: ProofOptions = {}): Promise<Check[]> {
  const deadline = Date.now() + (options.totalMs ?? 300_000);
  const results: Check[] = [];
  for (const check of checks) {
    const { ran: _ignored, ...clean } = check;
    if (!check.proof?.trim()) { results.push(clean); continue; }
    const remaining = deadline - Date.now();
    const ran = remaining <= 0 || options.signal?.aborted
      ? { code: -1, tail: options.signal?.aborted ? 'Stopped' : 'Total proof time limit reached', ms: 0 }
      : await run(cwd, check.proof, Math.min(options.timeoutMs ?? 120_000, remaining), options.signal);
    results.push({ ...clean, ran: { ...ran, ...(options.sha ? { sha: options.sha } : {}) } });
  }
  return results;
}
