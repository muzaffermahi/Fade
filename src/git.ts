import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type CheckpointResult = { sha: string; files: string[] } | { error: string };

export class Git {
  constructor(readonly cwd: string) {}

  private run(args: string[]): string {
    return execFileSync('git', args, { cwd: this.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  }

  isRepo(): boolean {
    try {
      return this.run(['rev-parse', '--is-inside-work-tree']).trim() === 'true';
    } catch {
      return false;
    }
  }

  init(): void {
    this.run(['init']);
  }

  /** Keeps .fade/ out of commits without touching the user's .gitignore. */
  excludeFade(): void {
    try {
      const gitDir = this.run(['rev-parse', '--git-path', 'info/exclude']).trim();
      const file = join(this.cwd, gitDir);
      const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
      if (current.split('\n').some(line => line.trim() === '.fade/')) return;
      mkdirSync(join(file, '..'), { recursive: true });
      appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}.fade/\n`);
    } catch {
      // Not fatal: worst case .fade/ shows up in a checkpoint.
    }
  }

  branch(): string {
    try {
      return this.run(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    } catch {
      return '';
    }
  }

  hasChanges(): boolean {
    try {
      return this.run(['status', '--porcelain']).trim().length > 0;
    } catch {
      return false;
    }
  }

  checkpoint(message: string): CheckpointResult {
    try {
      this.run(['add', '-A']);
      this.run(['commit', '-m', message]);
      const sha = this.run(['rev-parse', '--short', 'HEAD']).trim();
      const files = this.run(['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean);
      return { sha, files };
    } catch (error) {
      const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : '';
      const first = stderr.split('\n').find(line => line.trim()) ?? (error instanceof Error ? error.message : 'commit failed');
      return { error: first.trim() };
    }
  }

  show(sha: string): string {
    try {
      return this.run(['show', '--stat', '--patch', '--color=always', sha]);
    } catch {
      return 'Could not read that commit.';
    }
  }
}
