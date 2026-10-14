import { mkdtempSync, readFileSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const packageRoot=resolve(process.env.FADE_PACKAGE_ROOT??dirname(dirname(fileURLToPath(import.meta.url))));
const {Coordinator}=await import(pathToFileURL(join(packageRoot,'dist/coordinator.js')).href);
const {Store}=await import(pathToFileURL(join(packageRoot,'dist/store.js')).href);
const {PiAgents}=await import(pathToFileURL(join(packageRoot,'dist/pi.js')).href);
// Runs the compiled distributed product, with explicit role models and fresh work only.
const builderModel=process.env.FADE_BUILDER_MODEL,companionModel=process.env.FADE_COMPANION_MODEL;
if(!builderModel||!companionModel)throw new Error('Explicitly select both role models for the live evaluation.');
const wholeRunDeadlineMs=Number(process.env.FADE_EVALUATION_DEADLINE_MS??360000);
if(!Number.isSafeInteger(wholeRunDeadlineMs)||wholeRunDeadlineMs<60000||wholeRunDeadlineMs>1800000)throw new Error('Evaluation deadline must be 60s–30min.');
const workspace=mkdtempSync(join(tmpdir(),'fade-candidate-live-'));const store=new Store(workspace);store.lock();const state=Coordinator.initial(workspace,'A tiny local notebook');
const events=[];const started=Date.now();let overlap=false;
const c=new Coordinator(state,store,new PiAgents(store,state,{builderModel,companionModel}),notice=>{events.push({timestamp:Date.now(),...notice});console.log(`${notice.role}: ${notice.text}`);});
const timeout=setTimeout(()=>{void c.close();},wholeRunDeadlineMs);let passed=false;let failure;
console.log(`Candidate live workspace: ${workspace}`);
async function human(text) {
  await c.talk(text);const receipt=state.inputs.at(-1);
  if(receipt?.status==='failed') {console.log(`Explicit evaluation retry of saved input ${receipt.id}: ${receipt.error}`);c.retryInput(receipt.id);await c.talkAccepted(receipt.id);}
}
try {
  await human('What if we organized notes by mood? Explore the tradeoffs; do not implement anything.');
  if(state.slices.some(s=>s.status==='running'||s.status==='completed')||readdirSync(workspace).some(name=>name!=='.fade'))throw new Error('Exploration caused unintended execution');
  await human('Implement notebook.mjs exporting addNote(notes, text) as a new array of strings. Add README.md. Create only these two files, with no dependencies. Run exactly node --check notebook.mjs. Propose a ready bounded slice with one acceptanceChecks object: {"kind":"executable","criterion":"Module syntax is valid","command":"node --check notebook.mjs"}. Independent behavior checks run after the rehearsal.');
  overlap=state.slices.some(s=>s.status==='running');if(!overlap)throw new Error('No active foundation while Companion remained available');
  await human('Implement searchNotes(notes, query) next in notebook.mjs. Return strings matching a case-insensitive substring. Add a dependency-free notebook.test.mjs that checks search and addNote immutability; run exactly node notebook.test.mjs. Keep addNote unchanged. These are settled requirements; the foundation slice is the dependency. Declare acceptanceChecks as [{"kind":"executable","criterion":"Notebook behavior test passes","command":"node notebook.test.mjs"}].');
  await c.idle();if(state.slices.filter(s=>s.status==='completed').length<2)throw new Error(`A→B did not complete: ${state.slices.map(s=>s.status).join(', ')}`);
  const path=join(workspace,'notebook.mjs');if(!existsSync(path))throw new Error('Module missing');
  execFileSync(process.execPath,['--check',path]);
  execFileSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {pathToFileURL} from 'node:url';const m=await import(pathToFileURL(process.argv[1]).href);const before=['First Thought'];assert.deepEqual(m.addNote(before,'Second thought'),['First Thought','Second thought']);assert.deepEqual(before,['First Thought']);assert.deepEqual(m.searchNotes(['First Thought','another','THOUGHT'], 'thought'),['First Thought','THOUGHT']);assert.deepEqual(m.searchNotes([], 'x'),[]);console.log('INDEPENDENT_CHECK_OK');`,path],{stdio:'inherit'});
  if(!state.verificationEvidence.some(e=>e.toolName==='write'||e.toolName==='edit'))throw new Error('No observed real edits');
  passed=true;console.log('CANDIDATE LIVE PASS: exploration, real edit/check, Companion overlap, automatic A→B, independent behavior checks.');
} catch(error) {failure=error instanceof Error?error.message:String(error);process.exitCode=1;console.error(`CANDIDATE LIVE FAIL: ${failure}`);}
finally {clearTimeout(timeout);await c.close();writeFileSync(join(workspace,'evaluation.json'),JSON.stringify({builderModel,companionModel,passed,failure,overlap,elapsedMs:Date.now()-started,wholeRunDeadlineMs,packageRoot,candidateSha256:process.env.FADE_CANDIDATE_SHA256,node:process.version,platform:process.platform,slices:state.slices.map(s=>({id:s.id,title:s.plan.title,status:s.status})),events,scope:process.env.FADE_PACKAGE_ROOT?'Actually installed candidate adapters; provider latency included, UI/participant qualification separate':'Source compiled adapters; not exact-artifact qualification'},null,2));}
