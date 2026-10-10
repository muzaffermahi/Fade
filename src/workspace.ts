import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

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
