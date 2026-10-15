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
    goal: 'A notes app I would actually use every day',
    cards: [
      {
        title: 'Core notes app', state: 'review',
        body: 'Add, edit and delete notes, saved to disk.\nDone when: a note survives a reload.',
      },
      {
        title: 'Search', state: 'ready',
        body: 'Search notes by title and body as you type.\nDone when: typing "gro" shows "Groceries".',
      },
      { title: 'Notebook styling', state: 'draft', body: 'Warm paper, roomy margins, one column.\nDone when: it reads like a page.' },
    ],
    later: ['Export to markdown', 'Tags'],
    done: [{ title: 'Project setup' }],
  });
  const state = new StateStore(cwd);
  state.data.goalShipped = ['Project setup'];
  state.data.reviews.push({
    title: 'Core notes app',
    summary: 'Notes can be added, edited and deleted, and they are saved to disk.',
    howToTry: 'Open src/store.txt, then reload the app: your notes are still there.',
    tryCommand: `node -e "process.stdout.write(require('fs').readFileSync('src/store.txt','utf8'))"`,
    doneWhen: ['a note survives a reload.'],
    checks: [{ criterion: 'a note survives a reload.', passed: true, evidence: 'wrote a note, reloaded, read it back' }],
    sha,
    files: ['src/store.txt'],
    verdict: 'said',
    finishedAt: Date.now(),
  });
  state.data.companion.push(
    { role: 'you', text: 'Could it feel more like a notebook?' },
    { role: 'companion', text: 'Yes: warm paper, roomy margins, quiet controls. That is a step for after search lands.' },
    { role: 'card', text: 'Notebook styling' },
    { role: 'you', text: 'oh and export to markdown at some point, later' },
    { role: 'companion', text: 'Parked it in Later so it does not pull us off the goal.' },
    { role: 'parked', text: 'Export to markdown' },
  );
  state.save();
  return cwd;
}
