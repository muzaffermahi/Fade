import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Coordinator } from '../src/coordinator.js';
import { Store } from '../src/store.js';
import { PiAgents } from '../src/pi.js';

// Explicit opt-in: makes real model calls and runs generated code in a fresh temp workspace.
const builderModel = process.env.FADE_BUILDER_MODEL;
const companionModel = process.env.FADE_COMPANION_MODEL;
if (!builderModel || !companionModel) throw new Error('Set FADE_BUILDER_MODEL and FADE_COMPANION_MODEL explicitly before running the live smoke test.');
const workspace = mkdtempSync(join(tmpdir(), 'fade-live-'));
const store = new Store(workspace); store.lock();
const state = Coordinator.initial(workspace, 'Build a tiny dependency-free Node terminal notebook.');
const first = state.slices[0];
if (!first) throw new Error('Missing foundation slice');
first.plan = { title: 'Notebook foundation', goal: 'Create notebook.mjs exporting addNote(notes,text) returning a new array, and README.md. Verify with node --check notebook.mjs. No dependencies. Do not yet implement search.',
  requirements: ['Create notebook.mjs and README.md only.'], decisionKeys: [], dependencies: [], assumptions: [], ready: true };
const options = { builderModel, companionModel };
const c = new Coordinator(state, store, new PiAgents(store, state, options), notice => console.log(`${notice.role}: ${notice.text}`));
console.log(`Live workspace: ${workspace}`);
try {
  c.start();
  await c.talk('I definitely want the notebook to stay simple and local. While the foundation is being built, the next slice should add searchNotes(notes, query) to notebook.mjs with case-insensitive substring matching, returning only matching notes. Include a dependency-free Node test and actually run it. Do not add anything else. For me this should feel like retrieving a thought, not managing a database.');
  await c.idle();
  const completed = state.slices.filter(s => s.status === 'completed');
  if (completed.length < 2) throw new Error(`Rolling transition did not complete: ${state.slices.map(s => s.status).join(', ')}`);
  if (!existsSync(join(workspace, 'notebook.mjs'))) throw new Error('Pi did not write notebook.mjs');
  if (!readFileSync(join(workspace, 'notebook.mjs'), 'utf8').includes('searchNotes')) throw new Error('Second slice did not incorporate search requirement');
  if (!state.intent.decisions.length) throw new Error('No human decisions recorded');
  console.log('LIVE PASS: actual Pi wrote code, Companion recorded intent during execution, and A -> B completed.');
} finally { await c.close(); }
