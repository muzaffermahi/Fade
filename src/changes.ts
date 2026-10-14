import { readdir, lstat, open, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { Type } from 'typebox';
import { validate } from './contracts.js';
import { workspacePath } from './workspace.js';
import { terminalText } from './terminal-text.js';

/** Bounded read-only snapshots; excluded or externally edited files are explicitly uncertain. */
export const WorkspaceSnapshotSchema = Type.Object({ files: Type.Array(Type.Object({ path: Type.String(),
  hash: Type.String(), text: Type.String({ maxLength: 65536 }) }, { additionalProperties: false }), { maxItems: 300 }),
  limitations: Type.Array(Type.String()) }, { additionalProperties: false });
export type WorkspaceSnapshot = import('typebox').Static<typeof WorkspaceSnapshotSchema>;
export async function captureWorkspace(workspace: string): Promise<WorkspaceSnapshot> {
  const root = await realpath(workspace); const result: WorkspaceSnapshot = { files: [], limitations: [] }; let bytes = 0;
  const walk = async (directory: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (['.fade', '.git', 'node_modules'].includes(entry.name.toLowerCase())) continue;
      if (result.files.length >= 300 || bytes > 4000000) { result.limitations.push('Snapshot limit reached; omitted files have unknown changes.'); return; }
      const path = join(directory, entry.name), canonical = await realpath(path), name = relative(root, canonical);
      if (entry.isSymbolicLink() || isAbsolute(name) || name.startsWith('..')) { result.limitations.push(`Skipped symlink/outside path: ${entry.name}`); continue; }
      const stat = await lstat(path);
      if (stat.isDirectory()) { await walk(path); continue; }
      if (!stat.isFile() || stat.size > 65536) { result.limitations.push(`Omitted large/non-file: ${name}`); continue; }
      const checked = await workspacePath(root, path);
      const handle = await open(checked, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let buffer: Buffer;
      try {
        const opened = await handle.stat(), current = await lstat(await workspacePath(root, checked));
        if (!current.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || current.dev !== opened.dev || current.ino !== opened.ino) {
          throw new Error(`Workspace file changed during snapshot: ${name}`);
        }
        const bounded = Buffer.alloc(65537), read = await handle.read(bounded, 0, bounded.length, 0);
        if (read.bytesRead > 65536) { result.limitations.push(`Omitted file that grew beyond snapshot limit: ${name}`); continue; }
        buffer = bounded.subarray(0, read.bytesRead);
      } finally { await handle.close(); }
      const text = buffer.toString('utf8');
      if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(buffer)) { result.limitations.push(`Omitted non-UTF-8 text: ${name}`); continue; }
      bytes += buffer.length; result.files.push({ path: name, text, hash: createHash('sha256').update(buffer).digest('hex') });
    }
  };
  await walk(root); return validate(WorkspaceSnapshotSchema, result);
}
type DiffLine = { prefix: ' ' | '-' | '+'; text: string; old: number; next: number };
/** Bound quadratic comparison; large replacements explicitly fall back to a bounded view. */
function contextDiff(oldLines: string[], newLines: string[]): string {
  let prefix = 0, suffix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
  const oldEnd = oldLines.length - suffix, newEnd = newLines.length - suffix;
  const n = oldEnd - prefix, m = newEnd - prefix, lines: DiffLine[] = [];
  let old = Math.max(0, prefix - 3), next = old;
  const add = (kind: DiffLine['prefix'], text: string) => {
    lines.push({ prefix: kind, text, old, next }); if (kind !== '+') old++; if (kind !== '-') next++;
  };
  for (let offset = old; offset < prefix; offset++) add(' ', oldLines[offset] ?? '');
  const cells = (n + 1) * (m + 1); let fallback = false;
  if (cells > 262144) {
    fallback = true;
    for (const text of oldLines.slice(prefix, Math.min(oldEnd, prefix + 200))) add('-', text);
    for (const text of newLines.slice(prefix, Math.min(newEnd, prefix + 200))) add('+', text);
  } else {
    const lengths = new Uint32Array(cells), stride = m + 1;
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lengths[i * stride + j] = oldLines[prefix + i] === newLines[prefix + j]
      ? 1 + (lengths[(i + 1) * stride + j + 1] ?? 0) : Math.max(lengths[(i + 1) * stride + j] ?? 0, lengths[i * stride + j + 1] ?? 0);
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && oldLines[prefix + i] === newLines[prefix + j]) { add(' ', oldLines[prefix + i] ?? ''); i++; j++; }
      else if (i < n && (j === m || (lengths[(i + 1) * stride + j] ?? 0) >= (lengths[i * stride + j + 1] ?? 0))) { add('-', oldLines[prefix + i] ?? ''); i++; }
      else { add('+', newLines[prefix + j] ?? ''); j++; }
    }
  }
  if (!fallback) for (let offset = 0; offset < Math.min(3, suffix); offset++) add(' ', oldLines[oldEnd + offset] ?? '');
  const ranges: { start: number; end: number }[] = [];
  lines.forEach((line, index) => {
    if (line.prefix === ' ') return;
    const start = Math.max(0, index - 3), end = Math.min(lines.length, index + 4), last = ranges.at(-1);
    if (last && start <= last.end) last.end = end; else ranges.push({ start, end });
  });
  let rendered = fallback ? '[Large comparison: bounded replacement view; complete snapshots retained privately.]\n' : '';
  for (const range of ranges) {
    const chunk = lines.slice(range.start, range.end), first = chunk[0]; if (!first) continue;
    const removed = chunk.filter(line => line.prefix !== '+').length, added = chunk.filter(line => line.prefix !== '-').length;
    rendered += `@@ -${removed ? first.old + 1 : first.old},${removed} +${added ? first.next + 1 : first.next},${added} @@\n`
      + chunk.map(line => line.prefix + line.text).join('\n') + '\n';
    if (rendered.length > 40000) { rendered = terminalText(rendered, 40000) + '\n[Diff display truncated; complete snapshots retained privately.]'; break; }
  }
  return rendered;
}
/** Actual bounded context hunks; omissions and attribution remain explicitly uncertain. */
export function renderChanges(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string {
  const paths = [...new Set([...before.files, ...after.files].map(f => f.path))].sort();
  const hunks = paths.flatMap(path => {
    const a = before.files.find(f => f.path === path), b = after.files.find(f => f.path === path);
    if (a?.hash === b?.hash) return [];
    if ((!a && before.limitations.length) || (!b && after.limitations.length)) {
      return [`${path}: comparison incomplete; a missing snapshot entry may have been omitted. Creation/deletion is unknown.`];
    }
    const fileLines = (text: string | undefined): string[] => { if (!text) return []; const lines = text.split('\n'); if (text.endsWith('\n')) lines.pop(); return lines; };
    const oldLines = fileLines(a?.text), newLines = fileLines(b?.text);
    const newlineChanged = a && b && a.text.endsWith('\n') !== b.text.endsWith('\n');
    return [`--- ${terminalText(a ? path : '/dev/null')}\n+++ ${terminalText(b ? path : '/dev/null')}\n` + contextDiff(oldLines, newLines)
      + (newlineChanged ? `[Final newline ${b.text.endsWith('\n') ? 'added' : 'removed'}.]\n` : '')
      + (a?.text && !a.text.endsWith('\n') || b?.text && !b.text.endsWith('\n') ? '[A captured file has no final newline.]' : '')];
  });
  const body = hunks.join('\n\n'), truncated = body.length > 100000;
  return terminalText('Observed workspace changes during this slice. Attribution is uncertain: external programs may contribute edits. Files are only read, never restored or overwritten.\n\n'
    + (body ? terminalText(body, 100000) : 'No captured text changes.') + (truncated ? '\n[Diff display truncated; complete snapshots retained privately.]' : '')
    + '\n\n' + [...new Set([...before.limitations, ...after.limitations])].join('\n'), 110000);
}
