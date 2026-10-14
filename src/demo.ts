import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlanStore } from './plan.js';
import { StateStore } from './state.js';

/** Makes a throwaway git project with a sample plan, one finished card in review, and a short chat. */
export function createDemoWorkspace(): string {
  const cwd = mkdtempSync(join(tmpdir(), 'fade-demo-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.name', 'Fade Demo');
  git('config', 'user.email', 'demo@fade.local');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');

  mkdirSync(join(cwd, 'src'));
  writeFileSync(join(cwd, 'README.md'), '# Notes\n\nA tiny notes app.\n');
  writeFileSync(join(cwd, 'src', 'notes.txt'), 'Groceries\nIdeas\nReading list\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'Start project');
  writeFileSync(join(cwd, 'src', 'store.txt'), 'notes are saved to disk and survive a reload\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'fade: Core notes app');
  const sha = git('rev-parse', '--short', 'HEAD').trim();

  new PlanStore(cwd).save({
    preamble: '# Plan\n',
    cards: [
      { title: 'Core notes app', state: 'review', body: 'Add, edit and delete notes.\nDone when: a note survives a reload.' },
      { title: 'Search', state: 'ready', body: 'Search notes by title and body as you type.\nDone when: typing "gro" shows "Groceries".' },
      { title: 'Export to markdown', state: 'ready', body: 'One .md file per note in ./export.' },
      { title: 'Notebook styling', state: 'draft', body: 'Warm paper, roomy margins, one column.' },
      { title: 'Tags', state: 'draft', body: 'Tag a note and filter by tag.' },
    ],
    done: [{ title: 'Project setup' }],
  });
  const state = new StateStore(cwd);
  state.data.reviews.push({
    title: 'Core notes app',
    summary: 'Notes can be added, edited and deleted, and they are saved to disk.',
    howToTry: 'Open src/store.txt, then reload the app: your notes are still there.',
    sha,
    files: ['src/store.txt'],
    finishedAt: Date.now(),
  });
  state.data.companion.push(
    { role: 'you', text: 'Could it feel more like a notebook?' },
    { role: 'companion', text: 'Yes: warm paper, roomy margins, quiet controls. Want that as a card?' },
  );
  state.save();
  return cwd;
}
