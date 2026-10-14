import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, renameSync, readdirSync, readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../src/store.js';
import { Coordinator, toolPhase, authorizesImplementation, type Agents } from '../src/coordinator.js';
test('F-INTENT: negative instructions and embedded quotations cannot authorize implementation', () => {
  for (const text of ['Do not implement this', "I don't want you to change the module", 'The text is "Implement this"', '不要实现这个']) assert.equal(authorizesImplementation(text), false, text);
  assert.equal(authorizesImplementation('Implement the module. Do not add dependencies.'), true);
  assert.equal(authorizesImplementation('Implement the module. While it builds, read the essay and explain the tradeoff.'), true);
  assert.equal(authorizesImplementation('What if we changed the UI? Implement only the settled bug fix.'), true);
});
import { FadeApp } from '../src/app.js';
import { projectWork, ProjectionSchema } from '../src/projection.js';
import { validate, type CompanionReply, type ProjectState } from '../src/contracts.js';
const answer: CompanionReply = { reply: 'A saved thought.', evidence: [], openQuestions: [], next: null };
const agents: Agents = { build: async () => ({ status: 'completed', summary: 'Done', verification: [], discoveries: [] }), converse: async () => answer, close() {} };
const root = () => mkdtempSync(join(tmpdir(), 'fade-fault-'));
class FaultStore extends Store {
  fail = false;
  override save(state: ProjectState): void { if (this.fail) throw new Error('Injected disk full'); super.save(state); }
}
test('F-INPUT/F-CONTINUITY: authoritative storage failure rejects input and prevents execution until restart', async () => {
  const store = new FaultStore(root()); const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents);
  const id = c.accept('Accepted before failure'); store.fail = true;
  assert.throws(() => c.accept('Implement unsaved work'), /disk full/);
  assert.equal(c.state.inputs.length, 1); assert.equal(c.state.inputs[0]?.id, id); assert.equal(c.state.mode, 'paused');
  assert.throws(() => c.start(), /Storage unavailable/); assert.equal(c.state.slices.length, 0);
  await c.close(); const state = store.load(); assert.ok(state); assert.equal(state.inputs.length, 1);
  const recovered = new Coordinator(state, store, agents); store.fail = false; recovered.recover();
  assert.equal(state.inputs[0]?.status, 'interrupted'); await recovered.close();
});
test('F-CONTINUITY: renderer and derived mirror failures cannot revoke durable acceptance', async () => {
  const store = new Store(root()); mkdirSync(join(store.directory, 'state.json'));
  store.subscribe(() => { throw new Error('Renderer failed'); });
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents);
  const id = c.accept('This acknowledgement is durable'); assert.equal(store.load()?.inputs[0]?.id, id);
  assert.ok(store.diagnostics.length >= 2); await c.close();
});
test('F-CONTINUITY: checkpoint interruption and torn append recover latest state with full archives', () => {
  const store = new Store(root()); const state = Coordinator.initial(store.workspace, 'Explore');
  for (let n = 1; n <= 130; n++) { state.revision = n; store.save(state); }
  const archives = readdirSync(store.directory).filter(name => /^journal-/.test(name)); assert.equal(archives.length, 2);
  assert.ok(archives.some(name => readFileSync(join(store.directory, name), 'utf8').includes('"revision":1,')));
  store.checkpoint(state); renameSync(join(store.directory, 'journal.jsonl'), join(store.directory, 'interrupted-rename.jsonl'));
  assert.equal(store.load()?.revision, 130);
  writeFileSync(join(store.directory, 'journal.jsonl'), JSON.stringify({ ...state, revision: 129 }) + '\n{"partial":');
  assert.equal(store.load()?.revision, 130); assert.ok(readdirSync(store.directory).some(name => /^interrupted-.*\.txt$/.test(name)));
});
test('F-CONTINUITY: backward recovery crosses chunk boundaries without reading historical records', () => {
  const store = new Store(root()); const state = Coordinator.initial(store.workspace, 'Explore');
  writeFileSync(join(store.directory, 'journal.jsonl'), 'historical-corrupt-record\n'.repeat(300000));
  state.inputs.push({ id: 'attachment', sessionId: state.id, role: 'companion', mode: 'followUp', text: 'large attachment', attachments: [{type:'image',mimeType:'image/png',data:'a'.repeat(200000)}], status: 'accepted',timestamp:1,updatedAt:1,attempts:0,edits:[] });
  appendFileSync(join(store.directory, 'journal.jsonl'), JSON.stringify(state) + '\npartial');
  const saved = store.load(); assert.ok(saved); assert.equal(store.images(saved.inputs[0]?.attachments ?? [])[0]?.data.length, 200000);
});
test('F-CONTROL: configured run limits are validated, survive recovery, and reset only on explicit continuation', async () => {
  for (const invalid of [0, 21, 1.5, NaN]) assert.throws(() => Coordinator.initial('workspace', 'Explore', 'design', invalid));
  const store = new Store(root()); const app = new FadeApp(store, { runLimit: 2 }, () => {}, () => {}, () => agents);
  await app.submit('What if we changed this?'); const c = app.coordinator; assert.ok(c);
  assert.equal(c.state.remainingSlices, 2); c.state.remainingSlices = 0; store.save(c.state); await app.close();
  const again = new FadeApp(store, {}, () => {}, () => {}, () => agents); assert.equal(again.coordinator?.state.remainingSlices, 0);
  again.coordinator?.resume(); assert.equal(again.coordinator?.state.remainingSlices, 2); await again.close();
});
test('F-TUI/F-EVIDENCE: validated projection exposes observed per-role tokens and unknown monetary cost', () => {
  const state = Coordinator.initial('workspace', 'Explore'); state.usage = { companion: { tokens: 12, cost: null }, builder: { tokens: 34, cost: null } };
  const projection = projectWork(state); assert.equal(projection.usage.cost, 'unknown'); assert.match(projection.usage.builder, /34/);
  assert.throws(() => validate(ProjectionSchema, { ...projection, remaining: -1 }));
});
test('F-CONTROL: shutdown aborts active provider work, parks queues, releases ownership and process lock', async () => {
  const store = new Store(root()); store.lock(); let closed = false;
  const app = new FadeApp(store, {}, () => {}, () => {}, () => ({ ...agents, converse: async (_state, _message, signal) => new Promise<CompanionReply>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Provider cancelled')), {once:true});
  }), close() { closed = true; } }));
  const pending = app.submit('Think with me'); app.submit('Queued input'); await new Promise<void>(resolve => setImmediate(resolve));
  await app.close(); await pending; assert.equal(closed, true); assert.equal(app.coordinator?.state.ownership.owner, null);
  assert.ok(store.load()?.inputs.some(i => i.status === 'queued')); assert.ok(!readdirSync(store.directory).includes('lock'));
});

test('F-EVIDENCE: generic shells and unknown tools do not invent a checking or inspection phase', () => {
  assert.equal(toolPhase('bash', { args: { command: 'node --check index.mjs' } }), 'checking');
  assert.equal(toolPhase('bash', { args: { command: 'node --check index.mjs && touch other' } }), 'editing');
  assert.equal(toolPhase('custom-mcp', {}), 'editing'); assert.equal(toolPhase('read', {}), 'inspecting');
});
test('F-CONTINUITY: storage failure during real tool streaming aborts Builder and releases its lease', async () => {
  const store = new FaultStore(root()); let stream: (event: unknown) => void = () => {}; let aborted = false;
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, { ...agents,
    converse: async (_state, text) => ({reply:'Build',evidence:[{key:'request',text,quote:text,kind:'decision'}],openQuestions:[],next:{title:'Requested work',goal:text,requirements:[text],decisionKeys:['request'],acceptanceChecks:['node --check'],dependencies:[],assumptions:[],ready:true}}),
    build: async (_slice, signal, emit) => { stream = emit; return new Promise((_resolve, reject) => {signal.addEventListener('abort',()=>{aborted=true;reject(new Error('Aborted on storage failure'));},{once:true});}); }
  });
  await c.talk('Implement the module'); store.fail = true;
  stream({type:'tool_execution_start',toolName:'write',toolCallId:'write',args:{path:'result.mjs'}}); await c.idle();
  assert.equal(aborted,true); assert.equal(c.state.mode,'paused'); assert.equal(c.state.ownership.owner,null); assert.equal(c.state.slices[0]?.status,'interrupted'); await c.close();
});
test('F-CONTINUITY: extended input history retains every receipt across archived checkpoints', async () => {
  const store = new Store(root()); const c = new Coordinator(Coordinator.initial(store.workspace, 'Explore'), store, agents);
  for(let n=0;n<250;n++) {const id=c.accept(`Thought ${n}`); c.cancelInput(id);}
  const state=store.load(); assert.equal(state?.inputs.length,128); assert.equal(state?.archives?.inputs.count,122); assert.equal(state?.inputs.at(-1)?.text,'Thought 249');
  assert.ok(state?.inputs.every(input => input.status === 'cancelled'));
  assert.match(store.readRecordPage('inputs','Thought 0'), /Thought 0/); assert.match(store.readRecordPage('inputs','Thought 249'), /Thought 249/);
  assert.ok(readdirSync(store.directory).filter(name=>/^journal-/.test(name)).length>=7); await c.close();
});
