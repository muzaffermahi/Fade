import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { lstatSync, realpathSync, mkdirSync, fstatSync, readdirSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';

/** State is trusted local storage, not an OS sandbox against concurrent external programs. */
export class StateIntegrityError extends Error {}
const sameFile = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';
/** Pins canonical roots and rejects linked coordinator files before filesystem access. */
export class ProtectedStatePaths {
  readonly workspace: string;
  readonly directory: string;
  private readonly identities = new Map<string, BigIntStats>();
  constructor(workspace: string) {
    mkdirSync(workspace, { recursive: true });
    this.workspace = realpathSync(workspace);
    this.identities.set(this.workspace, lstatSync(this.workspace, { bigint: true }));
    this.directory = join(this.workspace, '.fade');
    this.inspect(this.directory);
    if (!this.stat(this.directory)) mkdirSync(this.directory);
    if (!this.inspect(this.directory)?.isDirectory()) throw new StateIntegrityError('Protected state path is not a directory.');
  }
  private stat(path: string): BigIntStats | undefined {
    try { return lstatSync(path, { bigint: true }); } catch (error) { if (missing(error)) return undefined; throw error; }
  }
  private inspect(path: string): BigIntStats | undefined {
    const stat = this.stat(path), expected = this.identities.get(path);
    if (!stat && expected) throw new StateIntegrityError(`Protected state directory disappeared: ${path}`);
    if (!stat) return undefined;
    // Every state ancestor is inspected and links are forbidden; canonicalizing every
    // leaf again would multiply filesystem round trips on each durable receipt.
    const rel = relative(this.workspace, path);
    if (stat.isSymbolicLink() || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || (stat.isFile() && stat.nlink !== 1n)
      || (path === this.workspace && realpathSync(path) !== this.workspace)) {
      throw new StateIntegrityError(`Linked or escaped protected state path: ${path}`);
    }
    if (expected && !sameFile(stat, expected)) throw new StateIntegrityError(`Protected state directory was replaced: ${path}`);
    if (stat.isDirectory()) this.identities.set(path, stat);
    return stat;
  }
  /** Reject devices/pipes/directories before open can block or access a non-file. */
  file(name: string): string {
    const path = this.path(name), stat = this.stat(path);
    if (stat && !stat.isFile()) throw new StateIntegrityError(`Protected state file is not a regular file: ${path}`);
    return path;
  }
  /** One validation of shared ancestors per batch; every leaf still receives the same link/identity checks. */
  files(names: readonly string[]): Map<string, BigIntStats | undefined> {
    this.inspect(this.workspace); this.inspect(this.directory);
    const directories = new Set([this.directory]), result = new Map<string, BigIntStats | undefined>();
    for (const name of names) {
      const target = resolve(this.directory, name), rel = relative(this.directory, target);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new StateIntegrityError('Invalid protected state descendant.');
      const parts = rel.split(sep); let parent = this.directory;
      for (const part of parts.slice(0, -1)) {
        parent = join(parent, part); if (!directories.has(parent)) { this.inspect(parent); directories.add(parent); }
      }
      const stat = this.inspect(target);
      if (stat && !stat.isFile()) throw new StateIntegrityError(`Protected state file is not a regular file: ${target}`);
      result.set(name, stat);
    }
    return result;
  }
  /** Validate each ancestor, including non-existent future descendants. */
  path(name: string): string {
    this.inspect(this.workspace); this.inspect(this.directory);
    const target = resolve(this.directory, name), rel = relative(this.directory, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new StateIntegrityError('Invalid protected state descendant.');
    let current = this.directory;
    for (const part of rel.split(sep)) { current = join(current, part); this.inspect(current); }
    return target;
  }
  /** Check an opened descriptor still identifies the validated single-link file. */
  opened(name: string, fd: number): void {
    const path = this.path(name), stat = lstatSync(path, { bigint: true }), opened = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || !opened.isFile() || opened.nlink !== 1n || !sameFile(stat, opened)) {
      throw new StateIntegrityError(`Protected state file changed during open: ${path}`);
    }
  }
  /** Pi owns session bytes; validate its directory tree without changing its tools. */
  directoryTree(name: string, create = true): string {
    const path = this.path(name);
    if (!this.stat(path)) {
      if (!create) return path;
      const parts = relative(this.directory, path).split(sep); let current = '';
      for (const part of parts) { current = join(current, part); const next = this.path(current); if (!this.stat(next)) mkdirSync(next); this.path(current); }
    }
    const walk = (parent: string): void => {
      if (!lstatSync(parent).isDirectory()) throw new StateIntegrityError(`Protected session path is not a directory: ${parent}`);
      for (const entry of readdirSync(parent)) { const child = this.path(relative(this.directory, join(parent, entry))); if (lstatSync(child).isDirectory()) walk(child); }
    };
    walk(path); return path;
  }
}

/** Validate lexical and resolved paths, including symlink ancestors of new files. */
export async function workspacePath(root: string, input: string): Promise<string> {
  const canonicalRoot = await realpath(root), target = resolve(canonicalRoot, input);
  const check = (path: string) => {
    const rel = relative(canonicalRoot, path);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ||
      rel.split(sep).some(part => part.toLowerCase() === '.fade' || part.toLowerCase() === '.git')) {
      throw new Error('Path is outside the application workspace or inside protected state.');
    }
  };
  check(target);
  let ancestor = target;
  while (true) {
    try {
      await lstat(ancestor); check(await realpath(ancestor)); break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error('No existing path ancestor.');
      ancestor = parent;
    }
  }
  return target;
}
