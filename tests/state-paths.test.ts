import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { Store } from '../src/store.js';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { captureWorkspace } from '../src/changes.js';
import type { TerminalState } from '../src/contracts.js';

const root = () => fs.mkdtempSync(join(tmpdir(), 'fade-state-'));
const terminal: TerminalState = { sessionId: 'fixture', mode: 'fade', focus: 'companion', builderDraft: '', companionDraft: 'Unsaved thought',
  builderScroll: 0, companionScroll: 0, builderAttachments: [], companionAttachments: [] };
const terminalName = `terminal-${createHash('sha256').update(terminal.sessionId).digest('hex')}.json`;
const agents: Agents = { build: async () => ({ status: 'completed', summary: 'Claim', verification: [], discoveries: [] }),
  converse: async () => ({ reply: 'Thought', evidence: [], openQuestions: [], next: null }), close() {} };
const restore = () => { mock.restoreAll(); syncBuiltinESMExports(); };

test('G36 F-CONTINUITY storage matrix: protected descendants reject links before every read/write', async () => {
  for (const name of ['lock', 'journal.jsonl', 'checkpoint.json', 'builder-events.jsonl', 'state.json', 'intent.json', 'intent.md', 'intent-edit.json', terminalName]) {
    const store = new Store(root()), outside = join(root(), 'private.txt'); fs.writeFileSync(outside, 'PRIVATE');
    fs.linkSync(outside, join(store.directory, name));
    const state = Coordinator.initial(store.workspace, 'Explore');
    const action = name === 'lock' ? () => store.lock() : name === terminalName ? () => store.saveTerminal(terminal)
      : name === 'intent-edit.json' ? () => store.readIntent() : () => store.save(state);
    assert.throws(action, /protected|Linked|outside Store/i, name);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'PRIVATE', name);
  }
  const store = new Store(root()), outside = root();
  fs.symlinkSync(outside, join(store.directory, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.sessionDirectory('conversation'), /Linked|protected/i);
  assert.deepEqual(fs.readdirSync(outside), []);
  const nested = new Store(root()); const dir = nested.sessionDirectory('builder');
  fs.symlinkSync(outside, join(dir, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => nested.sessionDirectory('builder'), /Linked|protected/i);
  // Snapshot aliases cannot pull state or outside payloads into a changes view.
  fs.symlinkSync(outside, join(nested.workspace, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  fs.writeFileSync(join(outside, 'private.txt'), 'PRIVATE');
  const snapshot = await captureWorkspace(nested.workspace); assert.equal(snapshot.files.length, 0);
  assert.ok(snapshot.limitations.some(line => line.includes('alias')));
});

test('G36/G41 F-CONTINUITY: root and ancestor replacements remain rejected after construction', () => {
  const created = new Store(join(root(), 'new workspace 空间', 'nested')); created.lock(); created.close();
  assert.equal(fs.existsSync(created.directory), true);
  const store = new Store(root()), outside = root();
  fs.renameSync(store.directory, join(store.workspace, 'saved-state'));
  fs.symlinkSync(outside, store.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => store.lock(), /Linked|protected/i); assert.deepEqual(fs.readdirSync(outside), []);
  fs.unlinkSync(store.directory); fs.mkdirSync(store.directory);
  assert.throws(() => store.saveTerminal(terminal), /Linked|replaced/i, 'integrity failure stays latched after a path is restored');
  const replaced = new Store(root()); fs.renameSync(replaced.directory, join(replaced.workspace, 'old-state')); fs.mkdirSync(replaced.directory);
  assert.throws(() => replaced.saveTerminal(terminal), /replaced/i, 'even a new ordinary .fade directory is a different owner');
});

test('G41 F-CONTINUITY: authoritative event/checkpoint edits and owned-lock tampering block further writes', () => {
  for (const name of ['builder-events.jsonl', 'checkpoint.json', 'lock']) {
    const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Explore'); store.lock(); store.save(state);
    if (name === 'builder-events.jsonl') store.event({ type: 'observed' });
    if (name === 'checkpoint.json') store.checkpoint(state);
    fs.appendFileSync(join(store.directory, name), 'foreign');
    assert.throws(() => store.save(state), /outside Store|lock changed/); assert.throws(() => store.saveTerminal(terminal), /outside Store|lock changed/);
    store.close();
  }
});

test('G36 F-CONTINUITY: exclusive unique temps do not overwrite fixed-temp files or collisions', () => {
  const store = new Store(root()); fs.writeFileSync(join(store.directory, `${terminalName}.tmp`), 'OLD FIXED TEMP');
  const original = fs.openSync, names: string[] = [];
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (String(path).endsWith('.tmp')) { assert.equal(flags, 'wx'); names.push(String(path)); }
    return original(path, flags, mode);
  }); syncBuiltinESMExports();
  try { store.saveTerminal(terminal); store.saveTerminal({ ...terminal, companionDraft: 'Second' }); }
  finally { restore(); }
  assert.equal(new Set(names).size, 2); assert.equal(fs.readFileSync(join(store.directory, `${terminalName}.tmp`), 'utf8'), 'OLD FIXED TEMP');
  assert.equal(store.loadTerminal('fixture')?.companionDraft, 'Second');
  let collision = '';
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (String(path).endsWith('.tmp')) { collision = String(path); fs.writeFileSync(path, 'COLLISION'); }
    return original(path, flags, mode);
  }); syncBuiltinESMExports();
  try { assert.throws(() => store.saveTerminal(terminal), /EEXIST/); }
  finally { restore(); }
  assert.equal(fs.readFileSync(collision, 'utf8'), 'COLLISION'); assert.equal(store.loadTerminal('fixture')?.companionDraft, 'Second');
});

test('G36/G41 F-CONTINUITY replacement matrix: opened journal and atomic temp identities are checked before mutation', () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Explore'); store.save(state);
  const outside = join(root(), 'outside'); fs.writeFileSync(outside, 'OUTSIDE');
  const original = fs.openSync;
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (basename(String(path)) === 'journal.jsonl') {
      fs.renameSync(path, join(store.directory, 'original-journal.jsonl')); fs.linkSync(outside, path);
    }
    return original(path, flags, mode);
  }); syncBuiltinESMExports();
  try { assert.throws(() => store.save(state), /Linked|protected/i); }
  finally { restore(); }
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
  const atomic = new Store(root()), sync = fs.fsyncSync; let temp = '';
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (String(path).endsWith('.tmp')) temp = String(path); return original(path, flags, mode);
  });
  mock.method(fs, 'fsyncSync', (fd: number) => {
    sync(fd); if (temp) { fs.unlinkSync(temp); fs.linkSync(outside, temp); }
  }); syncBuiltinESMExports();
  try { assert.throws(() => atomic.saveTerminal(terminal), /Linked|protected/i); }
  finally { restore(); }
  assert.equal(fs.existsSync(join(atomic.directory, terminalName)), false);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'OUTSIDE');
});

test('G41 F-INPUT/F-CONTINUITY: external journal tampering pauses execution and rejects new acceptance', async () => {
  const store = new Store(root()); store.lock();
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents); const accepted = c.accept('Saved first');
  fs.appendFileSync(join(store.directory, 'journal.jsonl'), '{"foreign":');
  assert.throws(() => c.accept('Implement unsaved work'), /outside Store/);
  assert.equal(c.state.mode, 'paused'); assert.equal(c.state.inputs.length, 1); assert.equal(c.state.inputs[0]?.id, accepted);
  assert.throws(() => c.start(), /Storage unavailable/); assert.throws(() => store.load(), /outside Store/);
  await c.close(); const restarted = new Store(store.workspace); restarted.lock();
  const saved = restarted.load(); assert.ok(saved); const recovered = new Coordinator(saved, restarted, agents); recovered.recover();
  assert.equal(saved.mode, 'paused'); assert.equal(saved.inputs[0]?.status, 'interrupted'); await recovered.close();
});

test('F20 F-INPUT storage matrix: actual open/fsync disk-full and permission errors never acknowledge acceptance', async () => {
  for (const code of ['ENOSPC', 'EACCES']) for (const stage of ['open', 'append', 'fsync']) {
    const store = new Store(root()), c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents);
    c.accept('Previously durable'); const original = fs.openSync, sync = fs.fsyncSync; let journalFd: number | undefined;
    const append = fs.appendFileSync, failure = () => Object.assign(new Error(`Injected ${code} at ${stage}`), { code });
    mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
      if (basename(String(path)) === 'journal.jsonl' && stage === 'open') throw failure();
      const fd = original(path, flags, mode); if (basename(String(path)) === 'journal.jsonl') journalFd = fd; return fd;
    });
    mock.method(fs, 'appendFileSync', (file: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
      if (file === journalFd && stage === 'append') { append(file, data.slice(0, Math.floor(data.length / 2)), options); throw failure(); }
      append(file, data, options);
    });
    mock.method(fs, 'fsyncSync', (fd: number) => { if (fd === journalFd && stage === 'fsync') throw failure(); sync(fd); }); syncBuiltinESMExports();
    try { assert.throws(() => c.accept('Must not be acknowledged'), new RegExp(code)); }
    finally { restore(); }
    assert.equal(c.state.inputs.length, 1); assert.equal(c.state.mode, 'paused'); await c.close();
    const restarted = new Store(store.workspace), saved = restarted.load(); assert.ok(saved);
    const recovered = new Coordinator(saved, restarted, agents); recovered.recover();
    assert.equal(saved.mode, 'paused'); assert.ok(saved.inputs.every(input => input.status === 'interrupted'));
    // fsync failure may leave complete bytes; recovery labels them uncertain, never resends them.
    assert.equal(saved.inputs.length, stage === 'fsync' ? 2 : 1); await recovered.close();
  }
});

test('F20 F-INPUT/F-CONTINUITY: fsync failure after authoritative acceptance cannot revoke a receipt', async () => {
  const store = new Store(root()), c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents);
  const open = fs.openSync, sync = fs.fsyncSync; const temps = new Set<number>();
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    const fd = open(path, flags, mode); if (String(path).endsWith('.tmp')) temps.add(fd); else temps.delete(fd); return fd;
  });
  mock.method(fs, 'fsyncSync', (fd: number) => { if (temps.has(fd)) throw Object.assign(new Error('Mirror ENOSPC'), { code: 'ENOSPC' }); sync(fd); });
  syncBuiltinESMExports(); let id: string;
  try { id = c.accept('Durable despite failed mirror'); } finally { restore(); }
  assert.equal(store.load()?.inputs[0]?.id, id); assert.ok(store.diagnostics.some(text => text.includes('Mirror ENOSPC')));
  await c.close();
});

test('F20 F-CONTINUITY checkpoint crash window: archived journal and checkpoint recover when replacement cannot open', () => {
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'Explore');
  for (let revision = 1; revision <= 63; revision++) { state.revision = revision; store.save(state); }
  const open = fs.openSync;
  mock.method(fs, 'openSync', (path: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (basename(String(path)).startsWith('journal.jsonl.') && String(path).endsWith('.tmp')) throw Object.assign(new Error('Replacement EACCES'), { code: 'EACCES' });
    return open(path, flags, mode);
  }); syncBuiltinESMExports();
  try { state.revision = 64; store.save(state); } finally { restore(); }
  assert.equal(fs.existsSync(join(store.directory, 'journal.jsonl')), false); assert.ok(store.diagnostics.some(text => /EACCES/.test(text)));
  const restarted = new Store(store.workspace); assert.equal(restarted.load()?.revision, 64);
  const archive = fs.readdirSync(store.directory).find(name => name.startsWith('journal-64-')); assert.ok(archive);
  assert.match(fs.readFileSync(join(store.directory, archive), 'utf8'), /"revision":1[,}]/); assert.match(fs.readFileSync(join(store.directory, archive), 'utf8'), /"revision":64[,}]/);
});

test('F20 F-CONTINUITY: live, stale, invalid and replaced process locks preserve ownership', () => {
  const store = new Store(root()); store.lock(); assert.throws(() => new Store(store.workspace).lock(), /already open/);
  fs.renameSync(join(store.directory, 'lock'), join(store.directory, 'old-lock'));
  fs.writeFileSync(join(store.directory, 'lock'), String(process.pid)); store.close();
  assert.equal(fs.existsSync(join(store.directory, 'lock')), true); assert.ok(store.diagnostics.some(text => /replaced/.test(text)));
  const invalid = new Store(root()); fs.writeFileSync(join(invalid.directory, 'lock'), 'invalid'); assert.throws(() => invalid.lock(), /Invalid/);
  const stale = new Store(root()); fs.writeFileSync(join(stale.directory, 'lock'), '2147483647'); stale.lock();
  assert.equal(fs.readFileSync(join(stale.directory, 'lock'), 'utf8'), String(process.pid)); stale.close();
});

test('F20 F-CONTINUITY recovery matrix: explicit relocation preserves exact bytes and returns paused provenance', () => {
  const old = new Store(root()), state = Coordinator.initial(old.workspace, 'Original project'); state.inputs.push({ id: 'uncertain', sessionId: state.id, role: 'companion',
    mode: 'followUp', text: 'Saved receipt', attachments: [], status: 'processing', timestamp: 1, updatedAt: 1, attempts: 1, edits: [] });
  old.save(state); old.checkpoint(state); const journal = fs.readFileSync(join(old.directory, 'journal.jsonl')), checkpoint = fs.readFileSync(join(old.directory, 'checkpoint.json'));
  const movedRoot = root(); fs.cpSync(old.directory, join(movedRoot, '.fade'), { recursive: true }); const moved = new Store(movedRoot);
  assert.throws(() => moved.load(), /explicit backed-up/); assert.throws(() => moved.relocate(old.workspace), /lock/); moved.lock();
  assert.throws(() => moved.relocate(root()), /Workspace moved/);
  const restored = moved.relocate(old.workspace); assert.equal(restored.workspace, moved.workspace); assert.equal(restored.revision, state.revision + 1);
  assert.equal(restored.mode, 'paused'); assert.equal(restored.inputs[0]?.status, 'interrupted'); assert.deepEqual(restored.sessions, { builders: [] });
  assert.equal(moved.load()?.id, state.id);
  assert.ok(fs.readdirSync(moved.directory).some(name => name.startsWith('journal-relocation-backup') && fs.readFileSync(join(moved.directory, name)).equals(journal)));
  assert.ok(fs.readdirSync(moved.directory).some(name => name.startsWith('checkpoint-relocation-backup') && fs.readFileSync(join(moved.directory, name)).equals(checkpoint)));
  assert.deepEqual(fs.readFileSync(join(old.directory, 'journal.jsonl')), journal); moved.close();
});

test('F20 F-CONTINUITY recovery matrix: malformed and conflicting state never repairs or overwrites original bytes', () => {
  for (const value of ['{"version":999}\npartial', '{"bad":"json"}\npartial', '{malformed}\npartial']) {
    const store = new Store(root()); fs.writeFileSync(join(store.directory, 'journal.jsonl'), value);
    assert.throws(() => store.load()); assert.equal(fs.readFileSync(join(store.directory, 'journal.jsonl'), 'utf8'), value);
    assert.deepEqual(fs.readdirSync(store.directory), ['journal.jsonl']);
  }
  const store = new Store(root()), state = Coordinator.initial(store.workspace, 'First'); store.save(state);
  fs.writeFileSync(join(store.directory, 'checkpoint.json'), JSON.stringify(Coordinator.initial(store.workspace, 'Different')));
  const bytes = fs.readFileSync(join(store.directory, 'journal.jsonl')); assert.throws(() => store.load(), /different project/);
  assert.deepEqual(fs.readFileSync(join(store.directory, 'journal.jsonl')), bytes);
});
