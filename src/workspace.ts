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
/** Conservative command gate, not an OS sandbox. Unknown commands need explicit consent. */
export function routineCommand(command: string): boolean {
  if (/[\n\r;&|<>`$]/.test(command) || /\.\.|\.fade|\.git\b|https?:|\b(?:deploy|publish|push|remove|delete|unlink|rm|rmdir|del|start|serve)\b/i.test(command)) return false;
  if (/(?:^|\s)(?:[A-Za-z]:[\\/]|\/|~)/.test(command)) return false;
  return /^(?:node\s+(?!--eval\b|-e\b)|npm\s+(?:install|test|run\s+(?:test|build|check|lint))\b|npx\s+(?:tsc|vitest)\b|(?:ls|pwd|rg|cat)\b)/.test(command.trim());
}
