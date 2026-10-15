import { existsSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import type { Card, CardState, DoneEntry, Plan } from './types.js';

const STATES: readonly string[] = ['draft', 'ready', 'building', 'review'];
const DEFAULT_PREAMBLE = '# Plan\n';
const GOAL_LINE = /^goal:[ \t]*(.*)$/im;

export function emptyPlan(): Plan {
  return { preamble: DEFAULT_PREAMBLE, goal: '', cards: [], later: [], done: [] };
}

function listItem(line: string): string | undefined {
  const match = /^\s*[-*]\s+(.*?)\s*$/.exec(line);
  return match?.[1] || undefined;
}

function parseDoneLine(line: string): DoneEntry | undefined {
  const item = listItem(line);
  if (!item) return undefined;
  const withSha = /^(.*?)\s*\(([0-9a-f]{4,40})\)$/.exec(item);
  if (withSha && withSha[1]) return { title: withSha[1], sha: withSha[2] as string };
  return { title: item };
}

/** Pulls the "Goal: …" line out of the preamble so it can be edited on its own. */
function splitGoal(preamble: string): { preamble: string; goal: string } {
  const match = GOAL_LINE.exec(preamble);
  if (!match) return { preamble, goal: '' };
  const rest = preamble.replace(GOAL_LINE, '').replace(/\n{3,}/g, '\n\n').trimEnd();
  return { preamble: rest ? `${rest}\n` : DEFAULT_PREAMBLE, goal: (match[1] ?? '').trim() };
}

function uniqueTitle(title: string, taken: Set<string>): string {
  if (!taken.has(title)) return title;
  let n = 2;
  while (taken.has(`${title} ${n}`)) n++;
  return `${title} ${n}`;
}

function parseHeading(heading: string): { state: string; title: string } {
  const match = /^\[([^\]]*)\]\s*(.*)$/.exec(heading);
  if (!match) return { state: 'draft', title: heading };
  return { state: (match[1] ?? '').trim().toLowerCase(), title: (match[2] ?? '').trim() };
}

export function parsePlan(text: string): Plan {
  const normalized = text.replace(/\r\n/g, '\n');
  const parts = normalized.split(/^(?=## )/m);
  const first = parts[0] ?? '';
  const hasPreamble = !first.startsWith('## ');
  const rawPreamble = hasPreamble && first.trim() ? first.trimEnd() + '\n' : DEFAULT_PREAMBLE;
  const { preamble, goal } = splitGoal(rawPreamble);
  const plan: Plan = { preamble, goal, cards: [], later: [], done: [] };
  const taken = new Set<string>();
  for (const section of hasPreamble ? parts.slice(1) : parts) {
    const newline = section.indexOf('\n');
    const heading = (newline < 0 ? section : section.slice(0, newline)).slice(3).trim();
    const body = newline < 0 ? '' : section.slice(newline + 1).trim();
    if (heading.toLowerCase() === 'done') {
      for (const line of body.split('\n')) {
        const entry = parseDoneLine(line);
        if (entry) plan.done.push(entry);
      }
      continue;
    }
    if (heading.toLowerCase() === 'later') {
      for (const line of body.split('\n')) {
        const item = listItem(line);
        if (item) plan.later.push(item);
      }
      continue;
    }
    const { state, title } = parseHeading(heading);
    if (!title) continue;
    if (state === 'done') {
      plan.done.push({ title });
      continue;
    }
    const cardState: CardState = STATES.includes(state) ? (state as CardState) : 'draft'; // narrowed by includes()
    const unique = uniqueTitle(title, taken);
    taken.add(unique);
    plan.cards.push({ title: unique, state: cardState, body });
  }
  return plan;
}

export function serializePlan(plan: Plan): string {
  let out = plan.preamble.trimEnd() + '\n';
  if (plan.goal.trim()) out += `Goal: ${plan.goal.trim()}\n`;
  out += '\n';
  for (const card of plan.cards) {
    out += `## [${card.state}] ${card.title}\n`;
    if (card.body) out += `${card.body}\n`;
    out += '\n';
  }
  if (plan.later.length > 0) {
    out += '## Later\n';
    for (const item of plan.later) out += `- ${item}\n`;
    out += '\n';
  }
  if (plan.done.length > 0) {
    out += '## Done\n';
    for (const entry of plan.done) out += entry.sha ? `- ${entry.title} (${entry.sha})\n` : `- ${entry.title}\n`;
  }
  return out.trimEnd() + '\n';
}

/** The card's acceptance lines: everything written after "Done when:". */
export function doneWhenLines(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const match = /^\s*(?:[-*]\s*)?done when:\s*(.+)$/i.exec(line);
    if (match?.[1]) out.push(match[1].trim());
  }
  return out;
}

export function makeUniqueTitle(cards: readonly Card[], title: string): string {
  return uniqueTitle(title, new Set(cards.map(card => card.title)));
}

export class PlanStore {
  readonly path: string;
  private lastWritten: string | undefined;
  private watcher: FSWatcher | undefined;
  private timer: NodeJS.Timeout | undefined;

  constructor(cwd: string) {
    this.path = join(cwd, 'PLAN.md');
  }

  load(): Plan {
    if (!existsSync(this.path)) return emptyPlan();
    return parsePlan(readFileSync(this.path, 'utf8'));
  }

  save(plan: Plan): void {
    const content = serializePlan(plan);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, content);
    renameSync(tmp, this.path);
    this.lastWritten = content;
  }

  watch(onExternalChange: () => void): () => void {
    const check = (): void => {
      if (!existsSync(this.path)) return;
      const content = readFileSync(this.path, 'utf8');
      if (content !== this.lastWritten) onExternalChange();
    };
    const schedule = (): void => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(check, 150);
    };
    try {
      // Watch the folder so a replaced file (rename) is still noticed.
      this.watcher = watch(join(this.path, '..'), (_event, name) => {
        if (name === 'PLAN.md') schedule();
      });
      this.watcher.on('error', () => undefined);
    } catch {
      // NOTE: if watching is unavailable the plan simply won't live-reload.
    }
    return () => {
      if (this.timer) clearTimeout(this.timer);
      this.watcher?.close();
    };
  }
}
