import { appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { IntentSchema, StateSchema, validate, type ProjectState } from './contracts.js';

/** One process owns a workspace; a durable journal is authoritative after a crash. */
export class Store {
  readonly directory: string;
  private lockOwned = false;
  constructor(readonly workspace: string) {
    this.directory = join(resolve(workspace), '.fade');
    mkdirSync(this.directory, { recursive: true });
  }
  lock(): void {
    const path = join(this.directory, 'lock');
    if (existsSync(path)) {
      const pid = Number(readFileSync(path, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid workspace lock; inspect .fade/lock.');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') alive = false;
      }
      if (alive) throw new Error(`Workspace is already open (process ${pid}).`);
      unlinkSync(path);
    }
    const fd = openSync(path, 'wx', 0o600);
    writeFileSync(fd, String(process.pid)); closeSync(fd); this.lockOwned = true;
  }
  close(): void {
    if (this.lockOwned) { unlinkSync(join(this.directory, 'lock')); this.lockOwned = false; }
  }
  load(): ProjectState | undefined {
    const journal = join(this.directory, 'journal.jsonl');
    if (!existsSync(journal)) return undefined;
    const raw = readFileSync(journal, 'utf8');
    const lastNewline = raw.lastIndexOf('\n');
    // An incomplete final append is not committed. Preserve it for inspection, then repair.
    if (lastNewline < raw.length - 1) {
      writeFileSync(join(this.directory, `interrupted-${randomUUID()}.txt`), raw.slice(lastNewline + 1));
      writeFileSync(journal, raw.slice(0, lastNewline + 1));
    }
    const last = raw.slice(0, lastNewline + 1).trim().split('\n').at(-1);
    if (!last) throw new Error('Journal has no complete state; refusing to overwrite it.');
    const state = validate(StateSchema, JSON.parse(last));
    if (resolve(state.workspace) !== resolve(this.workspace)) throw new Error('Workspace moved; state path needs explicit repair.');
    return state;
  }
  save(state: ProjectState): void {
    validate(StateSchema, state);
    const fd = openSync(join(this.directory, 'journal.jsonl'), 'a', 0o600);
    try { appendFileSync(fd, JSON.stringify(state) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    this.atomic('state.json', JSON.stringify(state, null, 2));
    this.atomic('intent.json', JSON.stringify(state.intent, null, 2));
    this.atomic('intent.md', renderIntent(state));
  }
  event(event: unknown): void {
    appendFileSync(join(this.directory, 'builder-events.jsonl'), JSON.stringify({ timestamp: Date.now(), event }) + '\n');
  }
  prepareIntentEdit(state: ProjectState): string {
    const path = join(this.directory, 'intent-edit.json');
    writeFileSync(path, JSON.stringify(state.intent, null, 2)); return path;
  }
  readIntent() { return validate(IntentSchema, JSON.parse(readFileSync(join(this.directory, 'intent-edit.json'), 'utf8'))); }
  private atomic(name: string, text: string): void {
    const target = join(this.directory, name), temp = `${target}.tmp`;
    writeFileSync(temp, text, { mode: 0o600 }); renameSync(temp, target);
  }
}
export function renderIntent(state: ProjectState): string {
  const entries = (kind: string) => state.intent.decisions.filter(d => d.kind === kind && d.status !== 'superseded')
    .map(d => `- ${d.text} [${d.status}; ${d.key}]\n  From you: “${d.quote}”`).join('\n') || '- None yet.';
  return `# Living Intent\n\n${state.intent.vision}\n\n## Design principles\n${entries('principle')}
\n## Established decisions\n${entries('decision')}\n\n## Implementation constraints\n${entries('constraint')}
\n## Explorations (not requirements)\n${entries('tentative')}\n\n## Open questions\n${state.intent.openQuestions.map(q => '- ' + q).join('\n') || '- None.'}
\n## Present and future\n${state.slices.map(s => `- ${s.plan.title}: ${s.status}\n  ${s.plan.goal}\n  Requirements: ${s.plan.requirements.join('; ')}\n  Decisions: ${s.plan.decisionKeys.join(', ')}\n  Depends on: ${s.plan.dependencies.join(', ')}\n  Assumptions: ${s.plan.assumptions.join('; ')}`).join('\n')}
\n## Discoveries\n${state.discoveries.map(d => '- ' + d.summary).join('\n') || '- None.'}\n`;
}
