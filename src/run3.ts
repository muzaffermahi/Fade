// Multi-project harness: runs 3 real projects through Fade's real Coordinator loop,
// with qwen3.5-2b (via LM Studio) as both Companion and Builder agent.
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Coordinator } from './coordinator.js';
import type { ProjectState } from './contracts.js';
import { Store } from './store.js';
import { LMStudioAgents } from './lmstudio-agent.js';

interface ProjectResult {
  idea: string;
  slices: Array<{ title: string; status: string }>;
}

async function runProject(idea: string): Promise<ProjectState> {
  const workspace = mkdtempSync(join(tmpdir(), 'fade-qwen-'));
  const store = new Store(workspace);
  store.lock();
  const state = Coordinator.initial(workspace, idea);
  const agents = new LMStudioAgents(workspace);
  const coord = new Coordinator(state, store, agents, () => {});
  try {
    coord.start();
    // Drive the loop: talk to Companion, which triggers Builder slices.
    await coord.talk(idea);
    await coord.idle();
    return state;
  } finally {
    await coord.close();
  }
}

const PROJECTS = [
  'A tiny Node.js crypto trading dashboard that fetches live BTC/USD price from a public exchange API, displays it in the terminal with a chart of last 20 prices, and logs buy/sell signals. No external dependencies.',
  'A dependency-free Node CLI that watches a GitHub repository name for commits and opens a PR when a new release is detected, then posts to Slack via webhook. Include a mock test that simulates the webhook call.',
  'A local-first task tracker web app (no database) using only Node built-in http module, with SQLite-style file storage in JSON, user authentication via JWT, and REST endpoints for CRUD operations on tasks.'
];

async function main() {
  const results: ProjectResult[] = [];
  for (const idea of PROJECTS) {
    console.log(`\n${'='.repeat(80)}\nPROJECT: ${idea.slice(0, 70)}...`);
    try {
      const state = await runProject(idea);
      results.push({ idea, slices: state.slices.map(s => ({ title: s.plan.title, status: s.status })) });
      for (const s of state.slices) {
        console.log(`  - ${s.plan.title} [${s.status}]`);
      }
    } catch (e) {
      console.error('PROJECT FAILED:', e);
    }
  }

  // Report summary.
  console.log('\n\n' + '='.repeat(80));
  console.log('FINAL SUMMARY');
  console.log('='.repeat(80));
  for (const [i, r] of results.entries()) {
    console.log(`\nProject ${i + 1}:`);
    console.log(`  Slices: ${r.slices.map(s => s.status).join(', ')}`);
  }
}

if (process.argv[2] === '--run') {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
} else {
  console.log('Usage: node --import tsx src/run3.ts --run');
}
