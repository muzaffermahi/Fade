import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InteractiveMode, ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore, createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import { visibleWidth, type Terminal } from '@earendil-works/pi-tui';
import { ActivityTracker, activityLine } from '../src/activity.js';
import { NotificationCenter, notification, notificationText } from '../src/notifications.js';
import { ActivitySchema, NotificationSchema, validate, type CompanionReply, type BuilderResult, type FadeNotification, type ProjectState } from '../src/contracts.js';
import { Coordinator, type Agents } from '../src/coordinator.js';
import { operationCard, outcomeCard } from '../src/reports.js';
import { projectWork } from '../src/projection.js';
import { providerDeadline } from '../src/pi.js';
import { Store } from '../src/store.js';
import { createFadeRuntime } from '../src/tui.js';
import { prepareChecks } from '../src/checks.js';

const answer: CompanionReply = { reply: 'Exploring.', evidence: [], openQuestions: [], next: null };
const completed: BuilderResult = { status: 'completed', summary: 'Implemented the core.', verification: ['Reported check'], discoveries: [] };
const proposal = (text: string): CompanionReply => ({ ...answer, evidence: [{ key: 'core', text, quote: text, kind: 'decision' }], next: {
  title: 'Core module', goal: text, requirements: ['Core module'], acceptanceChecks: ['node --check core.mjs'], decisionKeys: ['core'], dependencies: [], assumptions: [], ready: true,
} });
const tool = (type: string, id = 'check', output = 'Observed live output') => ({ type, toolCallId: id, toolName: 'bash', args: { command: 'node --check core.mjs' },
  partialResult: { content: [{ type: 'text', text: output }] }, result: { content: [{ type: 'text', text: output }] }, isError: false });
const prose = (text: string) => ({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text }] } });

test('G18/G19/G22/G23/G24/G26/G28 F-TUI: validated activity tracks silence, retry, compaction, parallel tools and cancellation without percentages', () => {
  let now = 1000; const activity = new ActivityTracker(() => now); let redraws = 0;
  activity.subscribe(() => redraws++); activity.subscribe(() => { throw new Error('Renderer unavailable'); });
  activity.begin('companion', 'session', 'input'); activity.update('companion', 'waiting_for_provider', 'Waiting for provider');
  now += 16000; assert.match(activityLine(activity.get('companion'), now), /16s.*No new activity.*awaiting provider/);
  now += 45000; assert.match(activityLine(activity.get('companion'), now), /Escape interrupts; \/diagnostics/);
  assert.equal(activity.get('companion').state, 'waiting_for_provider', 'silence is not failure');
  activity.observe('companion', { type: 'auto_retry_start', attempt: 2, maxAttempts: 3, delayMs: 50, errorMessage: 'Rate limited' });
  assert.match(activityLine(activity.get('companion'), now), /retry 2\/3.*Rate limited/);
  activity.observe('companion', { type: 'compaction_start' }); assert.equal(activity.get('companion').state, 'preparing');
  activity.observe('companion', { type: 'compaction_end', aborted: false }); assert.match(activity.get('companion').phase, /finished/);
  activity.observe('companion', prose('A'.repeat(8000) + '\x1b[2J')); assert.equal(activity.liveText('companion').length, 6000);
  activity.begin('builder', 'session', 'slice'); activity.observe('builder', tool('tool_execution_start'));
  assert.equal(activity.get('builder').state, 'checking'); activity.observe('builder', tool('tool_execution_update', 'check', 'line one\nline two\nline three'));
  now += 2000; const card = activity.tools('builder')[0]; assert.ok(card);
  assert.match(operationCard(card, false, now), /node --check core.mjs.*\nline one\nline two/);
  assert.match(operationCard(card, true, now), /2s.*\nline one\nline two\nline three/);
  activity.observe('builder', { type: 'tool_execution_start', toolName: 'read', toolCallId: 'read', args: { path: 'core.mjs' } });
  assert.equal(activity.get('builder').state, 'inspecting'); activity.observe('builder', tool('tool_execution_end'));
  assert.equal(activity.get('builder').tool, 'read', 'one ended call cannot erase another running call');
  activity.observe('builder', { type: 'tool_execution_end', toolName: 'read', toolCallId: 'read', result: { content: [] } });
  assert.equal(activity.get('builder').state, 'waiting_for_provider');
  activity.observe('builder', { type: 'role_context', tokens: 12, contextUsed: 50, contextWindow: 100 });
  assert.equal(activity.get('builder').usage?.contextUsed, 50);
  activity.cancel('builder'); activity.observe('builder', prose('Too late')); assert.equal(activity.get('builder').state, 'cancelling');
  assert.equal(activity.get('companion').state, 'streaming', 'role cancellation is isolated');
  activity.finish('builder', 'paused'); assert.equal(activity.get('builder').tool, undefined);
  activity.begin('builder', 'session', 'second'); for (let n = 0; n < 25; n++) activity.observe('builder', tool('tool_execution_start', String(n)));
  assert.equal(activity.tools('builder').length, 8); assert.ok(redraws > 20);
  for (let n = 1; n < 25; n++) activity.observe('builder', tool('tool_execution_end', String(n)));
  assert.equal(activity.get('builder').state, 'checking', 'evicting a card must not hide its still-running operation');
  activity.observe('builder', tool('tool_execution_end', '0')); assert.equal(activity.get('builder').state, 'waiting_for_provider');
  activity.observe('builder', { ...tool('tool_execution_start'), args: { command: 'node --check core.mjs; echo arbitrary' } });
  assert.equal(activity.get('builder').state, 'executing');
  assert.throws(() => validate(ActivitySchema, { ...activity.get('builder'), state: 'verified', percent: 100 }));
  assert.throws(() => validate(ActivitySchema, { ...activity.get('builder'), queueCount: -1 }));
});

test('G20/G21/G30 F-INPUT/F-TUI: typed feedback preserves causes, exact receipts and current actionable attention', () => {
  const state = Coordinator.initial('workspace', 'Explore'); const center = new NotificationCenter();
  const receipt = { id: 'input-id', sessionId: state.currentSessionId, role: 'companion' as const, mode: 'followUp' as const, text: 'Explore', status: 'failed' as const,
    attachments: [], timestamp: 1, updatedAt: 1, attempts: 1, error: 'Provider unavailable', edits: [] };
  state.inputs.push(receipt);
  const item: FadeNotification = { kind: 'provider_failure', role: 'companion', sessionId: state.currentSessionId, operationId: 'request', receiptId: receipt.id,
    timestamp: 1, cause: 'Provider unavailable\x1b[2J', actions: ['inputs', 'retry-input', 'diagnostics'] };
  center.add(item); assert.match(notificationText(notification(item)), /Provider unavailable\nNext: \/inputs · \/retry-input input-id/);
  assert.equal(center.visible('companion', state.currentSessionId, state).length, 1);
  assert.equal(center.visible('builder', state.currentSessionId, state).length, 0);
  assert.equal(center.visible('companion', 'different', state).length, 0);
  const saved = state.inputs[0]; assert.ok(saved); saved.status = 'cancelled';
  assert.equal(center.visible('companion', state.currentSessionId, state).length, 0); assert.equal(projectWork(state).needsYou, undefined);
  const plan = proposal('Implement core').next; assert.ok(plan);
  const checks = prepareChecks(plan), check = checks[0]; assert.ok(check); check.status = 'passed';
  check.history.push({ source: 'execution', sequence: 1, operationId: 'observed-fixture-check', toolName: 'bash', timestamp: 1, status: 'passed', evidence: 'Observed fixture success' });
  state.slices.push({ id: 'old', plan, status: 'blocked', result: { ...completed, status: 'blocked', summary: 'Old failure' } }, { id: 'new', plan, checks, status: 'completed', result: completed });
  assert.equal(projectWork(state).needsYou, undefined, 'superseded failure remains history');
  saved.status = 'interrupted'; saved.sessionId = 'previous'; assert.equal(projectWork(state).needsYou, undefined);
  for (const kind of ['acceptance_rejected', 'accepted_not_delivered', 'uncertain_delivery', 'provider_failure', 'tool_failure', 'storage_failure', 'unsupported_capability', 'invalid_command', 'intent_conflict', 'verification_failure'] as const) {
    assert.equal(notification({ ...item, kind }).kind, kind);
  }
  assert.throws(() => validate(NotificationSchema, { ...item, actions: ['run-external-command'] }));
  assert.throws(() => validate(NotificationSchema, { ...item, kind: 'success_claim' }));
});

class ActivityTerminal implements Terminal {
  columns = 120; rows = 40; kittyProtocolActive = false; frames = 0;
  input: (data: string) => void = () => {};
  start(input: (data: string) => void) { this.input = input; }
  stop() {} async drainInput() {} write() { this.frames++; } moveBy() {} hideCursor() {} showCursor() {}
  clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {}
}
const tick = (ms = 40) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function fixture(native = false, deadline?: number, suppliedStore?: Store, manual = false) {
  const store = suppliedStore ?? new Store(mkdtempSync(join(tmpdir(), 'fade-activity-'))); store.lock();
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find(model => model.provider === 'anthropic'); assert.ok(model);
  await modelRuntime.setRuntimeApiKey(model.provider, 'synthetic-never-sent');
  let buildEvent: (value: unknown) => void = () => {}, conversationEvent: (value: unknown) => void = () => {};
  let finishBuild: (value: BuilderResult) => void = () => {}, finishConversation: (value: CompanionReply) => void = () => {};
  const bridge = await createFadeRuntime(store, deadline ? { providerTurnDeadlineMs: deadline } : {}, (_store, _state, _options, converse): Agents => ({
    build: async (_slice, signal, event) => { buildEvent = event; return new Promise((resolve, reject) => {
      finishBuild = resolve; signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Builder cancelled')), 20), { once: true });
    }); },
    converse: async (state, text, signal, event) => {
      if (native) { assert.ok(converse); return converse(state, text, signal, event); }
      if (text.startsWith('Implement')) { const answer = proposal(text); if (manual && answer.next) answer.next.acceptanceChecks = [{ kind: 'manual', criterion: 'Inspect terminal contrast' }]; return answer; }
      conversationEvent = event ?? (() => {}); return new Promise((resolve, reject) => {
        finishConversation = resolve; signal.addEventListener('abort', () => setTimeout(() => reject(new Error('Companion cancelled')), 20), { once: true });
      });
    }, close() {},
  }), { modelRuntime, settingsManager: SettingsManager.inMemory({ packages: [], defaultProvider: model.provider, defaultModel: model.id, compaction: { enabled: false }, retry: { enabled: false } }) });
  const terminal = new ActivityTerminal(), mode = new InteractiveMode(bridge.runtime, { terminal, tuiMode: 'regular' });
  await mode.init(); void mode.run(); void bridge.openWorkspace(); await tick();
  const current = () => { const root = bridge.workspaceView; assert.ok(root); return root; };
  return { bridge, terminal, store, modelRuntime, model, current, buildEvent: (event: unknown) => buildEvent(event), conversationEvent: (event: unknown) => conversationEvent(event),
    finishBuild: () => finishBuild(completed), finishConversation: () => finishConversation(answer),
    close: async () => { bridge.disposeView(); mode.stop(); await bridge.app.close(); await bridge.runtime.dispose(); } };
}
test('G18/G19/G25/G27/G28 F-TUI: first request is visibly active before Builder starts, animates and refreshes auth', async () => {
  const f = await fixture();
  try {
    const root = f.current(); root.view.mode = 'companion'; root.view.focus = 'companion'; root.editors.companion.setText('Inspect the project'); f.terminal.input('\r'); await tick();
    assert.equal(f.bridge.app.coordinator?.state.inputs[0]?.status, 'processing');
    assert.match(root.render(120).join('\n'), /COMPANION.*waiting for provider/); assert.equal(f.bridge.app.coordinator?.state.slices.length, 0);
    const frames = f.terminal.frames; await tick(230); assert.ok(f.terminal.frames > frames, 'active spinner animates without state mutation');
    f.conversationEvent(prose('A live thought.')); await tick(); assert.match(root.render(120).join('\n'), /A live thought/);
    await f.modelRuntime.removeRuntimeApiKey(f.model.provider); assert.match(root.render(120).join('\n'), /Authentication needs setup/);
    await f.modelRuntime.setRuntimeApiKey(f.model.provider, 'synthetic-never-sent'); assert.doesNotMatch(root.render(120).join('\n'), /Authentication needs setup/);
    f.finishConversation(); await f.bridge.app.idle(); assert.equal(f.bridge.app.activity.get('companion').state, 'completed');
    assert.match(root.render(120).join('\n'), /Run 4 slices left.*Cost unknown/);
  } finally { await f.close(); }
});

test('G18–G29 F-TUI/F-EVIDENCE: simultaneous roles stream cards, retain drafts through resize and show one observed outcome', async () => {
  const f = await fixture(); const captures = join(f.store.workspace, 'captures'); mkdirSync(captures);
  try {
    await f.bridge.app.submit('Implement core', { role: 'builder' }); const root = f.current();
    const talking = f.bridge.app.submit('Inspect the project', { role: 'companion' }); await tick();
    assert.equal(f.bridge.app.activity.get('builder').state, 'waiting_for_provider'); assert.equal(f.bridge.app.activity.get('companion').state, 'waiting_for_provider');
    f.buildEvent(prose('Implementing the module now.')); f.conversationEvent(prose('Considering the next design.')); await tick();
    assert.match(root.render(120).join('\n'), /Implementing the module now/); assert.match(root.render(120).join('\n'), /Considering the next design/);
    f.buildEvent(tool('tool_execution_start')); f.buildEvent(tool('tool_execution_update', 'check', 'Checking the real module\nSecond output line\nThird output line')); await tick();
    root.view.focus = 'builder'; root.editors.builder.setText('Retained Builder draft'); root.editors.companion.setText('Retained Companion draft');
    for (const [width, height] of [[120, 40], [80, 24], [45, 20]]) {
      assert.ok(width !== undefined && height !== undefined); f.terminal.columns = width; f.terminal.rows = height;
      const screen = root.render(width); assert.ok(screen.every(line => visibleWidth(line) <= width)); assert.ok(screen.length <= height);
      assert.match(screen.join('\n'), /Checking the real module|node --check/); writeFileSync(join(captures, `${width}x${height}.txt`), screen.join('\n'));
    }
    f.terminal.columns = 120; f.terminal.rows = 40; f.terminal.input('\x0f');
    assert.match(root.render(120).join('\n'), /Third output line|Ctrl\+O collapses/);
    const interrupted = f.bridge.app.interrupt(); assert.equal(f.bridge.app.activity.get('companion').state, 'cancelling');
    assert.equal(f.bridge.app.coordinator?.state.slices[0]?.status, 'running'); await interrupted; await talking;
    assert.equal(f.bridge.app.activity.get('companion').state, 'paused'); assert.equal(root.editors.companion.getExpandedText(), 'Retained Companion draft');
    f.buildEvent(tool('tool_execution_end')); f.finishBuild(); await f.bridge.app.idle();
    const c = f.bridge.app.coordinator; assert.ok(c); const slice = c.state.slices[0]; assert.ok(slice);
    assert.equal(c.activity.get('builder').state, 'completed'); assert.equal(c.state.verificationEvidence.length, 1);
    root.view.mode = 'builder'; const screen = root.render(120).join('\n');
    assert.match(screen, /Observed: 1 completed tool operations/); assert.match(screen, /Reported checks/); assert.match(screen, /Limits:/);
    assert.equal(screen.split('Observed:').length - 1, 1); assert.match(outcomeCard(c.state, slice), /Observed: 1 completed tool operations/);
    assert.equal(root.editors.builder.getExpandedText(), 'Retained Builder draft');
    console.log(`F17 current workspace captures: ${captures}`);
  } finally { f.finishConversation(); f.finishBuild(); await f.close(); }
});

test('G34/G35 F-TUI/F-CONTROL: actual split shows manual acceptance separately from claims and routes human acceptance without provider work', async () => {
  const f = await fixture(false, undefined, undefined, true);
  try {
    await f.bridge.app.submit('Implement core'); const root = f.current(); f.finishBuild(); await f.bridge.app.idle();
    const c = f.bridge.app.coordinator, slice = c?.state.slices[0], check = slice?.checks?.[0]; assert.ok(c && slice && check);
    assert.equal(slice.status, 'blocked'); assert.equal(slice.result?.status, 'completed'); root.view.mode = 'builder'; root.view.focus = 'builder';
    assert.match(root.render(120).join('\n'), /needs human inspection|human inspection/); assert.match(f.bridge.app.inspect('builder'), /\/accept-check/);
    assert.equal(f.bridge.runtime.session.getActiveToolNames().includes('accept-check'), false, 'human action has no model tool');
    root.editors.builder.setText(`/accept-check ${slice.id} ${check.id} pass Inspected contrast on the current terminal.`); f.terminal.input('\r'); await tick();
    assert.equal(c.state.slices[0]?.status, 'completed'); assert.equal(c.state.slices[0]?.checks?.[0]?.history[0]?.source, 'human');
    assert.equal(f.bridge.runtime.session.isStreaming, false); assert.equal(root.editors.builder.getExpandedText(), '');
    assert.match(outcomeCard(c.state, c.state.slices[0] ?? slice), /acceptance: passed/);
  } finally { await f.close(); }
});

test('G21/G28 F-TUI/F-INPUT: real native provider deadline visibly fails once with saved input and no automatic retry', async () => {
  assert.equal(providerDeadline({}), 600000); for (const invalid of [0, -1, NaN, 1.5, 2147483648]) assert.throws(() => providerDeadline({ providerTurnDeadlineMs: invalid }));
  const f = await fixture(true, 80); let requests = 0;
  f.bridge.runtime.session.agent.streamFunction = (model, _context, options) => {
    requests++; const stream = createAssistantMessageEventStream();
    const message: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], stopReason: 'aborted', timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'start', partial: message }); options?.signal?.addEventListener('abort', () => stream.push({ type: 'error', reason: 'aborted', error: message }), { once: true });
    return stream;
  };
  try {
    const root = f.current(); root.view.focus = 'companion'; root.editors.companion.setText('Inspect the project'); f.terminal.input('\r'); await tick(180); await f.bridge.app.idle();
    assert.equal(requests, 1); assert.equal(f.bridge.app.coordinator?.state.inputs[0]?.status, 'failed');
    assert.equal(root.editors.companion.getExpandedText(), '', 'durable input is not duplicated in composer');
    assert.match(root.render(120).join('\n'), /Provider turn deadline reached/); assert.match(root.render(120).join('\n'), /retry-input|inputs/);
  } finally { await f.close(); }
});

test('G20/G21 F-INPUT/F-CONTINUITY: rejected draft is restored but a durable receipt survives later storage failure without duplication', async () => {
  class FaultStore extends Store {
    fail = false;
    override save(state: ProjectState): void { if (this.fail) throw new Error('Injected disk full after acceptance'); super.save(state); }
  }
  const store = new FaultStore(mkdtempSync(join(tmpdir(), 'fade-activity-fault-'))), f = await fixture(false, undefined, store);
  try {
    const root = f.current(); root.view.focus = 'companion';
    const oversized = 'Saved draft'.repeat(2001); root.editors.companion.setText(oversized); f.terminal.input('\r'); await tick();
    assert.equal(root.editors.companion.getExpandedText(), oversized); assert.equal(f.bridge.app.coordinator?.state.inputs.length ?? 0, 0);
    assert.equal(f.bridge.app.notifications.visible('companion', f.bridge.app.currentSessionId, f.bridge.app.coordinator?.state).at(-1)?.kind, 'acceptance_rejected');
    store.subscribe(() => { if (f.bridge.app.coordinator?.state.inputs.some(input => input.status === 'accepted')) store.fail = true; });
    root.editors.companion.setText('Durable input'); f.terminal.input('\r'); await tick();
    assert.equal(root.editors.companion.getExpandedText(), '', 'accepted input must not reappear as a new draft');
    const receipt = store.load()?.inputs.at(-1); assert.ok(receipt); assert.equal(receipt.text, 'Durable input');
    assert.equal(store.load()?.inputs.length, 1); assert.match(root.render(120).join('\n'), /Injected disk full|Storage failure/);
    assert.match(root.render(120).join('\n'), /inputs|restart|diagnostics/);
  } finally { await f.close(); }
});

test('G20/G21/G22 F-TUI/F-INPUT: accepted Builder delivery and actual tool failures retain typed causes and recovery', async () => {
  const store = new Store(mkdtempSync(join(tmpdir(), 'fade-activity-delivery-'))); const feedback: FadeNotification[] = [];
  let event: (value: unknown) => void = () => {}, release: (value: BuilderResult) => void = () => {};
  const c = new Coordinator(Coordinator.initial(store.workspace, 'Core'), store, {
    build: async (_slice, signal, emit) => { event = emit; return new Promise((resolve, reject) => { release = resolve; signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }); }); },
    converse: async (_state, text) => proposal(text), steerBuilder: async () => { throw new Error('Synthetic queue transport unavailable'); }, close() {},
  }, notice => { if (notice.notification) feedback.push(notice.notification); });
  try {
    await c.talk('Implement core'); const note = await c.messageBuilder('Keep the API small');
    const failure = feedback.find(item => item.kind === 'accepted_not_delivered'); assert.ok(failure);
    assert.equal(failure.receiptId, note.id); assert.match(failure.cause, /Synthetic queue transport unavailable/);
    assert.ok(store.load()?.inputs.some(input => input.id === note.id));
    event(tool('tool_execution_start')); event({ ...tool('tool_execution_end', 'check', 'Observed syntax error'), isError: true });
    release(completed); await c.idle(); assert.equal(c.state.slices[0]?.status, 'blocked');
    assert.ok(feedback.some(item => item.kind === 'tool_failure')); assert.ok(feedback.some(item => item.kind === 'verification_failure'));
    assert.match(operationCard(c.activity.tools('builder')[0] ?? { id: '', tool: '', target: '', startedAt: 0, updatedAt: 0, failed: false, output: '' }, true), /failed.*\nObserved syntax error/);
  } finally { release(completed); await c.close(); }
});
