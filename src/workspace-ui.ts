import { CustomEditor, getSelectListTheme, type KeybindingsManager, type Theme } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, wrapTextWithAnsi, getNativeClipboard, CURSOR_MARKER, SelectList, colorToRgb, visibleWidth, type OverlayHandle, type Component, type TUI, type AutocompleteProvider } from '@earendil-works/pi-tui';
import { randomUUID, createHash } from 'node:crypto';
import { basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { FadeApp } from './app.js';
import { projectWork } from './projection.js';
import { sessionConversation, type InputReceipt, type TerminalState, type FadeNotification, type ConversationRecord } from './contracts.js';
import { outcomeCard, operationCard } from './reports.js';
import { activityLine, visibleText } from './activity.js';
import { notificationText } from './notifications.js';
import { routeInput, commandCatalog, type CommandDefinition, type CommandRoute } from './commands.js';
import { NativeUIAdapter } from './native-ui.js';
import { imageMime, imageBytes, textCharacters, validateSendText, IMAGE_LIMITS } from './payloads.js';
import { renderedText } from './terminal-text.js';
export { focusedComponent } from './native-ui.js';

type Role = 'builder' | 'companion';
type TranscriptRow = { text: string; source: string; offset: number; revision: string };
type ReadingAnchor = { source: string; offset: number; scroll: number };
export type Submission = { role: Role; sessionId: string; text: string; mode: InputReceipt['mode']; attachments: InputReceipt['attachments']; route: CommandRoute; accepted: (receiptId: string) => void };
/** Measure native completion rows using its public border override, without private editor fields. */
class Composer extends CustomEditor {
  private bottomBorder = '';
  private exactArgumentText: string | undefined;
  override setAutocompleteProvider(provider: AutocompleteProvider): void {
    super.setAutocompleteProvider({
      ...(provider.triggerCharacters ? { triggerCharacters: provider.triggerCharacters } : {}),
      getSuggestions: async (...args) => {
        const suggestions = await provider.getSuggestions(...args);
        this.exactArgumentText = suggestions && !suggestions.prefix.startsWith('/') && suggestions.items.some(item => item.value === suggestions.prefix)
          && /^\s*\/\S+\s/.test(args[0].join('\n')) ? args[0].join('\n') : undefined;
        return suggestions;
      },
      applyCompletion: (...args) => provider.applyCompletion(...args),
      shouldTriggerFileCompletion: (...args) => provider.shouldTriggerFileCompletion?.(...args) ?? false,
    });
  }
  hasExactArguments(): boolean { return this.exactArgumentText !== undefined && this.getText() === this.exactArgumentText; }
  protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
    this.bottomBorder = super.renderBottomBorder(width, hiddenLineCount); return this.bottomBorder;
  }
  renderParts(width: number): { body: string[]; menu: string[] } {
    const lines = this.render(width);
    const boundary = lines.findIndex((line, index) => index > 0 && line === this.bottomBorder);
    return { body: lines.slice(1, boundary < 0 ? lines.length - 1 : boundary), menu: boundary < 0 ? [] : lines.slice(boundary + 1) };
  }
}
const mint = (s: string) => `\x1b[38;2;166;239;220m${s}\x1b[39m`;
const lavender = (s: string) => `\x1b[38;2;190;158;240m${s}\x1b[39m`;
const muted = (s: string) => `\x1b[38;2;164;171;190m${s}\x1b[39m`;
// Explicit tile silhouettes keep the counters clean and every square separate.
const logoLetters = [
  ['11111', '11111', '11000', '11110', '11110', '11000', '11000'],
  ['011110', '111111', '110011', '111111', '111111', '110011', '110011'],
  ['111110', '111111', '110011', '110011', '110011', '111111', '111110'],
  ['11111', '11110', '11000', '11111', '11010', '11111', '11111'],
];
const logoTrail = [
  'M  M  M    M    M   M           ',
  ' M  M   M     M    L    M       ',
  'M  M   M  M      L    L      L  ',
  ' M   M   M   M    L      L      ',
  'M   M   M   M   L    L     L    ',
  '  M   M    M   M   L   L    M   ',
  'M   M   M    M   L    L   L     ',
];
// Close mint fragments hug the middle bar before dispersing into the existing trail.
const logoNearEdge = [' ', 'M', ' ', 'M', ' ', 'M', ' '];
const logoNearTrail = ['M M ', ' M M', 'M M ', ' MM ', 'M M ', ' M M', 'M M '];
/** Separate near-square native tiles, with ivory FAD and a dissolving mint E. */
export function wordmark(width: number, background = '18;20;22', palette?: { accent: (text: string) => string; secondary: (text: string) => string; text: (text: string) => string; muted: (text: string) => string }): string[] {
  const accent = palette?.accent ?? mint, secondary = palette?.secondary ?? lavender;
  if (width < 76) return [accent('FADE') + (palette?.muted ?? muted)('  ·  A tool for the mind.')];
  // Two-column tile pitch matches a normal terminal row. The half block leaves a
  // slim horizontal gap; a background-colored underline separates tile rows.
  const tile = `\x1b[4m\x1b[58;2;${background}m▐█\x1b[24m\x1b[59m`;
  const ivory = palette?.text ?? ((text: string) => `\x1b[38;2;245;244;222m${text}\x1b[39m`);
  const trailColumns = Math.min(32, Math.max(0, Math.floor(width / 2) - 26));
  return Array.from({ length: 7 }, (_, row) => {
    const letters = logoLetters.map((letter, index) => [...(letter[row] ?? '')].map((cell, col) => {
      if (cell === '0' || (index === 3 && col === 4 && row === 1)) return '  ';
      return index < 3 ? ivory(tile) : accent(tile);
    }).join('')).join('  ');
    const near = logoNearTrail[row] ?? '';
    const trail = [...(near + (logoTrail[row] ?? '').slice(near.length))].slice(0, trailColumns).map(cell =>
      cell === 'M' ? accent(tile) : cell === 'L' ? secondary(tile) : '  ').join('');
    return letters + (logoNearEdge[row] === 'M' ? accent(tile) : '  ') + trail;
  });
}

/** One public Pi root; each native editor owns its own draft/history/paste state. */
export class WorkspaceUI implements Component {
  focused = true;
  readonly editors: Record<Role, Composer>;
  readonly view: TerminalState;
  private readonly off: () => void;
  private readonly inputOff: () => void;
  private readonly activityOff: () => void;
  private readonly notificationOff: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private disposed = false;
  private split = false;
  private error = '';
  private readonly expanded: Record<Role, boolean> = { builder: false, companion: false };
  private interruptedAt: number | undefined;
  private readonly branch: string;
  private readonly paneRows: Record<Role, number> = { builder: 0, companion: 0 };
  private readonly lastContent: Record<Role, number> = { builder: 0, companion: 0 };
  private readonly anchors: Partial<Record<Role, ReadingAnchor>> = {};
  private readonly contentSignatures: Record<Role, string> = { builder: '', companion: '' };
  private readonly newOutput: Record<Role, boolean> = { builder: false, companion: false };
  private readonly readingMessages: Record<Role, ConversationRecord[]> = { builder: [], companion: [] };
  private readonly images: Record<Role, InputReceipt['attachments']> = { builder: [], companion: [] };
  private imagePicker: OverlayHandle | undefined;
  private readonly switchKey = (['tab', 'ctrl+space', 'ctrl+tab', 'alt+right'] as const).find(key => key === process.env.FADE_PANE_KEY) ?? 'tab';
  private readonly color: (s: string) => string;
  private readonly muted = (text: string) => process.env.NO_COLOR !== undefined ? text : this.theme.fg('muted', text);
  private readonly secondary = (text: string) => process.env.NO_COLOR !== undefined ? text : this.theme.fg('customMessageLabel', text);
  constructor(private readonly tui: TUI, private readonly theme: Theme, private readonly keys: KeybindingsManager,
    private readonly app: FadeApp, private readonly submit: (input: Submission) => Promise<void>,
    private readonly leave: (command?: string, key?: string) => void,
    private readonly streaming: () => { role: Role; text: string } | undefined = () => undefined,
    private readonly authReady: boolean | (() => boolean) = true,
    private readonly catalog: () => readonly CommandDefinition[] = () => commandCatalog(),
    private readonly nativeShortcut: (data: string) => boolean = () => false,
    private readonly nativeAdapter = new NativeUIAdapter(tui), restoreStartupDraft = true,
    private readonly imagesSupported: (role: Role) => boolean | undefined = () => undefined) {
    this.color = s => process.env.NO_COLOR !== undefined ? s : this.theme.fg('accent', s);
    const sessionId = app.currentSessionId;
    const saved = app.store.loadTerminal(sessionId) ?? (restoreStartupDraft && !app.coordinator ? app.store.loadTerminal('welcome') : undefined);
    this.view = saved ? { ...saved, sessionId } : { sessionId, mode: 'fade', focus: 'builder', builderDraft: '', companionDraft: '', builderScroll: 0, companionScroll: 0 };
    for (const role of ['builder', 'companion'] as const) {
      const reading = role === 'builder' ? this.view.builderReading : this.view.companionReading, scroll = role === 'builder' ? this.view.builderScroll : this.view.companionScroll;
      if (!reading || !scroll) continue;
      this.anchors[role] = { source: reading.source, offset: reading.offset, scroll };
      try {
        this.readingMessages[role] = app.store.findConversations(reading.pageIds).filter(message => message.scope === 'session' && message.sessionId === sessionId
          && (message.targetRole ?? (message.role === 'companion' ? 'companion' : undefined)) === role);
      } catch (error) { this.error = visibleText(error instanceof Error ? error.message : String(error)); }
    }
    this.images.builder = app.store.referenceImages(this.view.builderAttachments ?? []); this.images.companion = app.store.referenceImages(this.view.companionAttachments ?? []);
    for (const role of ['builder', 'companion'] as const) {
      const draft = role === 'builder' ? this.view.builderDraft : this.view.companionDraft;
      this.images[role] = this.images[role].map((image, index) => {
        const oldMarker = `[image ${index + 1}]`; return !image.draftMarker && draft.includes(oldMarker) ? { ...image, draftMarker: oldMarker } : image;
      });
    }
    try { this.branch = execFileSync('git', ['branch', '--show-current'], { cwd: app.store.workspace, encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { this.branch = ''; }
    const make = (role: Role) => {
      let originalText = '';
      const editor = new class extends Composer {
        override handleInput(data: string): void { originalText = this.getExpandedText(); super.handleInput(data); }
      }(tui, { borderColor: this.color, selectList: getSelectListTheme() }, keys, { paddingX: 1 });
      editor.setText(role === 'builder' ? this.view.builderDraft : this.view.companionDraft);
    for (const input of app.coordinator?.state.inputs.filter(i => i.role === role && i.sessionId === app.currentSessionId).slice(-100) ?? []) editor.addToHistory(input.text);
      editor.onChange = () => this.save();
      editor.onSubmit = text => { void this.send(role, originalText.trim() === text ? originalText : text, role === 'builder' ? 'steer' : 'followUp'); };
      editor.onEscape = () => { void this.interrupt(role); };
      editor.onCtrlD = () => this.leaveNative('/quit');
      editor.onPasteImage = () => { void this.pasteImage(role); };
      return editor;
    };
    this.editors = { builder: make('builder'), companion: make('companion') };
    this.flush();
    this.off = app.store.subscribe(() => {
      if (this.view.mode === 'fade' && !this.split && app.coordinator?.state.slices.some(s => s.status === 'running')) {
        this.split = true; this.view.focus = 'companion'; this.save();
      }
      this.tui.requestRender();
    });
    this.split = Boolean(app.coordinator?.state.slices.length);
    this.activityOff = app.activity.subscribe(() => tui.requestRender());
    this.notificationOff = app.notifications.subscribe(() => tui.requestRender());
    this.timer = setInterval(() => { if (app.activity.active) tui.requestRender(); }, 100); this.timer.unref();
    this.nativeAdapter.mount(this);
    this.inputOff = tui.addInputListener(() => { if (!tui.hasOverlay()) tui.setFocus(this); return undefined; });
    this.nativeAdapter.onUnmount(() => { this.imagePicker?.hide(); this.imagePicker = undefined; this.disposed = true; this.off(); this.inputOff(); this.activityOff(); this.notificationOff(); clearInterval(this.timer); });
  }
  /** Local feedback also crosses the shared typed renderer boundary. */
  notify(text: string, kind: FadeNotification['kind'] = 'result', role = this.view.focus): void {
    this.error = visibleText(text);
    this.app.notifications.add({ kind, role, sessionId: this.app.currentSessionId, operationId: 'local-control', cause: this.error || 'Completed', timestamp: Date.now(),
      actions: kind === 'acceptance_rejected' ? ['edit-draft', 'diagnostics'] : kind === 'unsupported_capability' || kind === 'invalid_command' ? ['edit-draft'] : [] });
    this.tui.requestRender();
  }
  /** Reinstalled by the public Pi wrapper after session/resource changes. */
  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.editors.builder.setAutocompleteProvider(provider); this.editors.companion.setAutocompleteProvider(provider);
  }
  private fail(error: unknown, kind: FadeNotification['kind'] = 'result', role = this.view.focus): void { this.notify(error instanceof Error ? error.message : String(error), kind, role); }
  private async interrupt(role: Role): Promise<void> {
    this.flush();
    try {
      const c = this.app.coordinator, processing = c?.state.inputs.find(i => i.status === 'processing');
      if (!processing || processing.role === role) await this.app.interrupt();
      if (role === 'builder') await c?.pause();
    } catch (error) { this.fail(error); }
  }
  private save(): void {
    if (!this.editors || this.disposed) return;
    // The mounted editors belong to their captured session, including during native replacement.
    this.view.builderDraft = this.editors.builder.getExpandedText(); this.view.companionDraft = this.editors.companion.getExpandedText();
    for (const role of ['builder', 'companion'] as const) {
      const text = this.editors[role].getExpandedText(); this.images[role] = this.images[role].filter(image => !image.draftMarker || text.includes(image.draftMarker));
    }
    this.view.builderAttachments = this.images.builder; this.view.companionAttachments = this.images.companion;
    for (const role of ['builder', 'companion'] as const) {
      const key = role === 'builder' ? 'builderReading' : 'companionReading', anchor = this.anchors[role];
      if (anchor && anchor.source.length <= 4096) this.view[key] = { source: anchor.source, offset: anchor.offset, pageIds: this.readingMessages[role].map(message => message.id).filter(id => id.length <= 4096).slice(0, 64) };
      else delete this.view[key];
    }
    try { this.app.store.queueTerminal(this.view, error => { if (!this.disposed) this.fail(error); }); } catch (error) { this.fail(error); }
  }
  private flush(): void { this.save(); this.app.store.flushTerminal(this.view.sessionId); }
  private leaveNative(command?: string, key?: string): void { this.flush(); this.leave(command, key); }
  /** Local attachment management never sends a prompt or changes the other role's tray. */
  openAttachments(): void {
    const role = this.view.focus, sessionId = this.view.sessionId; this.flush();
    this.imagePicker?.hide();
    const items = this.images[role].map((image, index) => ({ value: String(index), label: `Remove image ${index + 1} · ${visibleText(image.mimeType.replace('image/', '').toUpperCase(), 80)}` }));
    const picker = new SelectList([...items, { value: 'all', label: 'Remove all images' }, { value: 'close', label: 'Keep images and close' }], 8, getSelectListTheme());
    const close = () => { this.imagePicker?.hide(); this.imagePicker = undefined; this.tui.requestRender(); };
    picker.onCancel = close;
    picker.onSelect = item => {
      if (!this.disposed && this.view.sessionId === sessionId && item.value !== 'close') {
        const index = Number(item.value), removed = item.value === 'all' ? this.images[role] : Number.isInteger(index) ? this.images[role].filter((_image, position) => position === index) : [];
        this.images[role] = this.images[role].filter(image => !removed.includes(image));
        let text = this.editors[role].getExpandedText(); for (const image of removed) if (image.draftMarker) text = text.replaceAll(image.draftMarker, '');
        this.editors[role].setText(text); this.flush();
      }
      close();
    };
    this.imagePicker = this.tui.showOverlay(picker, { width: '90%', maxHeight: '80%', anchor: 'center' }); this.tui.requestRender();
  }
  private async pasteImage(role: Role): Promise<void> {
    const sessionId = this.app.coordinator?.state.currentSessionId;
    try {
      const image = await getNativeClipboard()?.getImage();
      if (!image) throw new Error('No clipboard image available. /pi opens native attachment controls; /fade returns.');
      if (sessionId !== this.app.coordinator?.state.currentSessionId) throw new Error('Session changed; image was not attached.');
      const marker = `[image:${randomUUID()}]`, attachment = { type: 'image' as const, mimeType: imageMime(image), data: Buffer.from(image).toString('base64'), draftMarker: marker };
      this.app.store.validateNewImages([...this.images[role], attachment]); this.images[role].push(...this.app.store.referenceImages([attachment]));
      this.editors[role].insertTextAtCursor(marker); this.flush(); this.tui.requestRender();
    } catch (error) { this.fail(error, 'unsupported_capability', role); }
  }
  private async send(role: Role, text: string, mode: InputReceipt['mode']): Promise<void> {
    if (!text.trim()) return;
    const draftImages = [...this.images[role]];
    try {
      validateSendText(text);
      if (draftImages.length && this.imagesSupported(role) === false) throw new Error('The selected model does not support images. Choose a vision model or remove images with Ctrl+Alt+I.');
      this.app.store.validateNewImages(draftImages);
    } catch (error) {
      queueMicrotask(() => { if (!this.disposed) { this.images[role] = draftImages; this.editors[role].setText(text); this.flush(); this.fail(error, 'acceptance_rejected', role); } });
      return;
    }
    this.flush();
    const route = routeInput(text, 'split', this.catalog());
    if (route.kind === 'rejected' || route.kind === 'menu') {
      this.notify(route.kind === 'rejected' ? route.error : 'Type a command; /help lists controls.', route.kind === 'rejected' ? 'invalid_command' : 'result', role);
      // Pi clears its editor after synchronous onSubmit. Restore after that edit.
      queueMicrotask(() => { if (!this.disposed) { this.editors[role].setText(text); this.save(); this.tui.requestRender(); } });
      return;
    }
    if (route.kind === 'shell' || (route.kind === 'command' && route.command.category === 'native')) { this.leaveNative(route.text); return; }
    let acceptedId: string | undefined;
    const input: Submission = { role, sessionId: this.app.currentSessionId, text, mode, attachments: [...this.images[role]], route, accepted: id => { acceptedId = id; } };
    this.app.notifications.dismissLocal(role);
    this.error = ''; this.editors[role].addToHistory(text); this.editors[role].setText(''); this.images[role] = []; this.flush();
    try { await this.submit(input); } catch (error) {
      if (acceptedId) this.app.report('uncertain_delivery', role, acceptedId, `${error instanceof Error ? error.message : String(error)} Input remains saved; inspect its receipt before retrying.`, ['inputs', 'diagnostics'], acceptedId);
      else { this.images[role] = input.attachments; this.editors[role].setText(text); this.flush(); this.fail(error, 'acceptance_rejected', role); }
    }
  }
  handleInput(data: string): void {
    if (matchesKey(data, 'ctrl+alt+i')) { this.openAttachments(); return; }
    const editor = this.editors[this.view.focus];
    if (editor.isShowingAutocomplete() && editor.hasExactArguments() && this.keys.matches(data, 'tui.input.submit')) editor.setText(editor.getExpandedText());
    // An open picker owns navigation, confirmation and dismissal before pane/app keys.
    if (editor.isShowingAutocomplete() && (['tui.select.up', 'tui.select.down', 'tui.select.confirm', 'tui.select.cancel', 'tui.input.tab'] as const)
      .some(action => this.keys.matches(data, action))) {
      editor.handleInput(data); this.tui.requestRender(); return;
    }
    if (matchesKey(data, this.switchKey)) { this.flush(); this.view.focus = this.view.focus === 'builder' ? 'companion' : 'builder'; if (this.view.mode !== 'fade') this.view.mode = this.view.focus; this.flush(); this.tui.requestRender(); return; }
    for (const [key, mode] of [['alt+1', 'builder'], ['alt+2', 'companion'], ['alt+3', 'fade']] as const) {
      if (matchesKey(data, key)) { this.flush(); this.view.mode = mode; if (mode !== 'fade') this.view.focus = mode; this.flush(); this.tui.requestRender(); return; }
    }
    if (matchesKey(data, 'ctrl+c')) {
      this.flush();
      const now = Date.now(), c = this.app.coordinator;
      const active = this.view.focus === 'builder' ? Boolean(c?.state.slices.some(slice => slice.status === 'running'))
        || Boolean(c?.isConversing && c.state.inputs.some(input => input.status === 'processing' && input.role === 'builder'))
        : Boolean(c?.isConversing && c.state.inputs.some(input => input.status === 'processing' && input.role === 'companion'));
      if ((this.interruptedAt !== undefined && now - this.interruptedAt <= 1000) || !active) this.leaveNative('/quit');
      else { this.interruptedAt = now; this.notify('Interrupting focused work. Ctrl+C again within one second exits.'); void this.interrupt(this.view.focus); }
      return;
    }
    if (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown')) {
      const role = this.view.focus;
      const key = role === 'builder' ? 'builderScroll' : 'companionScroll';
      // Scroll a full visible pane of history per press; 5-row steps lose older messages.
      const step = Math.max(6, this.paneRows[role] || 12);
      this.view[key] = Math.max(0, this.view[key] + (matchesKey(data, 'pageUp') ? step : -step));
      delete this.anchors[role]; if (!this.view[key]) this.newOutput[role] = false;
      this.save(); this.tui.requestRender(); return;
    }
    if (this.keys.matches(data, 'app.message.followUp')) { void this.send(this.view.focus, this.editors[this.view.focus].getExpandedText(), 'followUp'); return; }
    if (this.keys.matches(data, 'app.tools.expand')) { this.expanded[this.view.focus] = !this.expanded[this.view.focus]; this.tui.requestRender(); return; }
    if (this.nativeShortcut(data)) { this.leaveNative(undefined, data); return; }
    // Keep stock native app controls discoverable through the native editor adapter.
    if (this.nativeAdapter.nativeFocus instanceof CustomEditor) {
      for (const action of this.nativeAdapter.nativeFocus.actionHandlers.keys()) {
        if (['app.interrupt', 'app.exit', 'app.clear', 'app.message.followUp', 'app.clipboard.pasteImage'].includes(action)) continue;
        if (this.keys.matches(data, action)) { this.leaveNative(undefined, data); return; }
      }
    }
    this.editors[this.view.focus].handleInput(data); this.tui.requestRender();
  }
  private transcript(role: Role, width: number): TranscriptRow[] {
    const muted = this.muted, lavender = this.secondary;
    const state = this.app.coordinator?.state;
    const recent = state ? sessionConversation(state).filter(m => (m.targetRole ?? state.inputs.find(i => i.id === m.id)?.role ?? 'companion') === role).slice(-60) : [];
    const ids = new Set(recent.map(message => message.id)), scroll = role === 'builder' ? this.view.builderScroll : this.view.companionScroll;
    const messages = [...(scroll ? this.readingMessages[role].filter(message => !ids.has(message.id)) : []), ...recent];
    const rows: TranscriptRow[] = [];
    const add = (source: string, text: string, indent = '', signature = visibleText(text, 20000)) => {
      const revision = createHash('sha256').update(signature).digest('hex');
      let offset = 0;
      for (const paragraph of text.split('\n')) {
        let consumed = 0;
        for (const line of wrapTextWithAnsi(paragraph, Math.max(1, width - indent.length))) {
          const plain = visibleText(line, 20000), found = paragraph.indexOf(plain, consumed), start = found < 0 ? consumed : found;
          rows.push({ text: indent + line, source, offset: offset + start, revision }); consumed = start + plain.length;
        }
        offset += paragraph.length + 1;
      }
    };
    const blank = (source: string) => rows.push({ text: '', source: source + ':end', offset: 0, revision: '' });
    for (const message of messages) {
      add(message.id + ':label', message.role === 'human' ? lavender('you') : this.color(role));
      add(message.id, visibleText(message.text, 20000), '  '); blank(message.id);
    }
    const live = this.streaming();
    const liveText = this.app.activity.liveText(role) || (live?.role === role ? live.text : '');
    if (liveText) { add('live-label', this.color(role)); add('live', visibleText(liveText, 6000)); blank('live'); }
    for (const operation of this.app.activity.tools(role).slice(-3)) { add('tool:' + operation.id, operationCard(operation, this.expanded[role], Date.now(), role === 'companion' ? '/pi' : '/log'), '', operation.output + String(operation.endedAt) + String(operation.failed)); blank('tool:' + operation.id); }
    if (role === 'builder' && state) {
      for (const slice of state.slices.slice(-1)) {
        if (slice.status === 'running' && messages.length) continue;
        add('slice:' + slice.id, visibleText(slice.status === 'running' ? `${slice.plan.title}\n${slice.plan.goal}` : outcomeCard(state, slice), 6000)); blank('slice:' + slice.id);
      }
      const queued = state.inputs.filter(i => i.role === role && i.sessionId === state.currentSessionId && ['accepted', 'queued', 'processing'].includes(i.status));
      if (queued.length) add('queue', muted(`${queued.length} saved/queued · /inputs shows receipts`));
    }
    for (const item of this.app.notifications.visible(role, this.app.currentSessionId, state).filter(item => item.kind !== 'result')) { add(`notification:${item.kind}:${item.operationId}`, notificationText(item)); blank(`notification:${item.kind}:${item.operationId}`); }
    if (!rows.length) { add('welcome', muted(role === 'builder' ? 'Build the present.' : 'Think about what’s next.')); blank('welcome'); add('welcome-help', role === 'builder' ? 'Request a concrete change, or build the plan you discussed with Companion.' : 'Explore an idea, inspect the project, or develop the next design. Workspace access is read-only.'); }
    return rows;
  }
  private pane(role: Role, width: number, height: number): string[] {
    const muted = this.muted;
    const selected = this.view.focus === role;
    const activity = this.app.activity.get(role), silence = Date.now() - activity.lastActivityAt;
    const slow = ['preparing', 'waiting_for_provider', 'streaming', 'inspecting', 'executing', 'checking', 'cancelling'].includes(activity.state);
    const rows = height >= 4 ? [this.color(role.toUpperCase() + (selected ? ' · focused' : '')) + muted(`  │  ${activityLine(activity)}`)] : [];
    if (height >= 12 && slow && silence >= 15000) rows.push(muted(silence >= 60000 ? 'No new activity · Escape · /diagnostics' : `No new activity · awaiting ${activity.tool ? 'tool output' : 'provider'}`));
    const editor = this.editors[role]; editor.focused = selected && this.focused; editor.borderColor = selected ? this.color : muted;
    const framed = height >= 10, captionRows = height >= 3 ? 1 : 0;
    const imageRows = this.images[role].length && height >= 8 ? 1 : 0;
    const base = (framed ? 2 : 0) + captionRows + imageRows;
    const menuBudget = Math.max(0, height - rows.length - base - 1);
    editor.setAutocompleteMaxVisible(Math.max(1, Math.min(5, menuBudget - 1)));
    const parts = editor.renderParts(Math.max(1, width - (framed ? 2 : 0)));
    const nativeMenu = parts.menu.map(renderedText); let menu = nativeMenu.slice(0, menuBudget);
    // Pi's public editor clamps its menu to at least three entries. Allocate a
    // measured window around its actual selection when fewer rows fit here.
    if (menuBudget && nativeMenu.length > menuBudget) {
      const last = nativeMenu.at(-1), indicator = last && /^\s*\(\d+\/\d+\)/.test(visibleText(last)) ? last : undefined;
      const items = indicator ? nativeMenu.slice(0, -1) : nativeMenu;
      const selectedItem = Math.max(0, items.findIndex(line => visibleText(line).trimStart().startsWith('→ ')));
      const slots = Math.max(1, menuBudget - (indicator && menuBudget > 1 ? 1 : 0));
      const first = Math.max(0, Math.min(selectedItem - Math.floor(slots / 2), items.length - slots));
      menu = items.slice(first, first + slots);
      if (indicator) {
        if (menuBudget === 1) menu = [truncateToWidth(menu[0] ?? '', Math.max(1, width - visibleWidth(indicator.trim()) - 1), '…') + ' ' + indicator.trim()];
        else menu.push(indicator);
      }
    }
    const rendered = parts.body.map(renderedText);
    const visible = Math.max(1, Math.min(4, height - rows.length - base - menu.length)), cursor = rendered.findIndex(line => line.includes(CURSOR_MARKER));
    const start = Math.max(0, cursor - visible + 1), body = rendered.slice(start, start + visible);
    const border = selected ? this.color : muted;
    const count = textCharacters(editor.getExpandedText()), images = this.images[role], bytes = images.reduce((sum, image) => sum + (typeof image.data === 'string' ? imageBytes(image.data) : image.decodedBytes), 0);
    const imageHint = images.length && !imageRows ? ` I${images.length}` : '';
    const caption = height <= 3 ? `${role === 'builder' ? 'Builder' : 'Companion'}${imageHint} resize`
      : count > 20000 ? ` Over limit ${count}/20,000 · draft kept${imageHint}` : ` Message ${role === 'builder' ? 'Builder' : 'Companion'}${imageHint} · ${count}/20,000`;
    const composer = [...(framed ? [border('╭' + '─'.repeat(Math.max(0, width - 2)) + '╮')] : []),
      ...(captionRows ? [framed ? border('│') + truncateToWidth(caption, Math.max(1, width - 2), '…', true) + border('│') : truncateToWidth(caption, width)] : []),
      ...(imageRows ? [truncateToWidth(` Images ${images.length}/${IMAGE_LIMITS.count} · ${(bytes / 1048576).toFixed(1)}/30 MiB · Ctrl+Alt+I`, width)] : []),
      ...body.map(line => framed ? border('│') + truncateToWidth(line, Math.max(1, width - 2), '…', true) + border('│') : line),
      ...(framed ? [border('╰' + '─'.repeat(Math.max(0, width - 2)) + '╯')] : []), ...menu];
    const available = Math.max(0, height - rows.length - composer.length);
    const content = this.transcript(role, Math.max(1, width));
    const key = role === 'builder' ? 'builderScroll' : 'companionScroll';
    const hash = createHash('sha256'); let previousSource = '';
    for (const row of content) if (row.source !== previousSource) { hash.update(row.source).update(row.revision); previousSource = row.source; }
    const signature = hash.digest('hex');
    if (this.view[key] && this.contentSignatures[role] && signature !== this.contentSignatures[role]) this.newOutput[role] = true;
    this.contentSignatures[role] = signature;
    const noticeRows = available >= 2 && this.view[key] ? 1 : 0, visibleContent = Math.max(0, available - noticeRows);
    this.paneRows[role] = Math.max(1, visibleContent); this.lastContent[role] = content.length;
    let begin = Math.max(0, content.length - this.view[key] - visibleContent);
    const anchor = this.anchors[role];
    if (this.view[key] && anchor && anchor.scroll === this.view[key]) {
      const position = content.findLastIndex(row => row.source === anchor.source && row.offset <= anchor.offset);
      if (position >= 0) begin = position;
    }
    begin = Math.min(begin, Math.max(0, content.length - visibleContent));
    this.view[key] = Math.max(0, content.length - begin - visibleContent);
    if (!this.view[key]) { this.newOutput[role] = false; delete this.anchors[role]; this.readingMessages[role] = []; }
    else { const first = content[begin]; if (first && visibleContent) this.anchors[role] = { source: first.source, offset: first.offset, scroll: this.view[key] }; }
    if (this.view[key] && visibleContent) {
      const sources = new Set(content.slice(begin, begin + visibleContent).map(row => row.source.replace(/:(label|end)$/, '')));
      const current = this.app.coordinator ? sessionConversation(this.app.coordinator.state) : [];
      const pool = new Map([...this.readingMessages[role], ...current].map(message => [message.id, message]));
      this.readingMessages[role] = [...pool.values()].filter(message => sources.has(message.id)).slice(0, 64);
    }
    rows.push(...content.slice(begin, begin + visibleContent).map(row => row.text));
    if (noticeRows) rows.push(muted(this.newOutput[role] ? 'New output · PgDn · /history' : 'Reading history · PgDn · /history'));
    while (rows.length < height - composer.length) rows.push('');
    rows.push(...composer);
    return rows.map(line => truncateToWidth(line, width, '…', true));
  }
  render(width: number): string[] {
    const muted = this.muted, lavender = this.secondary;
    const height = Math.max(1, this.tui.terminal.rows - 1), padding = width >= 12 ? 2 : 0, inner = Math.max(1, width - padding * 2);
    const active = Boolean(this.app.coordinator?.state.slices.length);
    const hasMenu = this.editors[this.view.focus].isShowingAutocomplete();
    const background = colorToRgb(this.theme.colors.customMessageBg);
    const brand = !active && !hasMenu && height >= 30 ? ['', ...wordmark(inner, `${background.r};${background.g};${background.b}`, {
      accent: this.color, secondary: this.secondary, muted: this.muted, text: text => process.env.NO_COLOR !== undefined ? text : this.theme.fg('text', text) }), '', 'A tool for the mind.', ''] : [this.color('FADE') + muted('  ·  A tool for the mind.'), ''];
    let header = [...brand, this.color('─'.repeat(inner)),
      truncateToWidth(`${this.color('□')} ${visibleText(basename(this.app.store.workspace))}${this.branch ? muted('  │  git ') + visibleText(this.branch) : ''}  ` + muted(visibleText(`Companion · ${this.app.options.companionModel ?? 'configured model'}  │  Builder · ${this.app.options.builderModel ?? 'configured model'}`)), inner), '',
      ['builder', 'companion', 'fade'].map(mode => { const label = ` ${mode[0]?.toUpperCase() + mode.slice(1)} `; return this.view.mode === mode ? this.color(`\x1b[4m${label}\x1b[24m`) : muted(label); }).join('    '),
      ...(!(typeof this.authReady === 'function' ? this.authReady() : this.authReady) ? [lavender('Authentication needs setup · /login or /model')] : []), this.color('─'.repeat(inner))];
    const projection = projectWork(this.app.coordinator?.state);
    projection.now = visibleText(projection.now, 20000).replace(/\n/g, ' '); projection.next = visibleText(projection.next, 20000).replace(/\n/g, ' ');
    if (projection.needsYou) projection.needsYou = visibleText(projection.needsYou, 20000).replace(/\n/g, ' ');
    const urgent = (['builder', 'companion'] as const).flatMap(role => this.app.notifications.visible(role, this.app.currentSessionId, this.app.coordinator?.state)).findLast(item => item.kind !== 'result');
    const recovery = urgent?.actions.length ? notificationText(urgent).split('\n').at(-1) ?? '' : '/status for details';
    const compactRecovery = urgent ? 'Next: ' + urgent.actions.map(action => action === 'edit-draft' ? 'edit draft' : action === 'retry-input' ? '/inputs' : action === 'restart' ? 'repair / restart' : `/${action}`).join(' · ') : '/status';
    let footer = [muted('─'.repeat(inner)), truncateToWidth(this.color('Now  ') + muted(projection.now) + '  │  ' + lavender('Next  ') + muted(projection.next), inner),
      ...(projection.needsYou ? [truncateToWidth(lavender('Needs you  ') + projection.needsYou, inner)] : []),
      ...(urgent ? [truncateToWidth(lavender(`${urgent.role}: ${urgent.cause}`), inner), truncateToWidth(recovery, inner)]
        : this.error ? [truncateToWidth(lavender(this.error), inner)] : []),
      truncateToWidth(muted(`Run ${projection.remaining} slices left · Companion ${projection.usage.companion} · Builder ${projection.usage.builder} · Cost unknown`), inner), this.color('─'.repeat(inner)),
      truncateToWidth(muted(`${this.switchKey} switch pane  │  Alt+1/2/3 mode  │  `) + this.color('/intent  /changes  /pause  /pi'), inner)];
    if (this.view.mode === 'fade' && (!active || width < 110) && !hasMenu) footer.splice(-1, 0, truncateToWidth(active ? `Fade: ${this.view.focus} pane · /status shows Builder` : 'Fade split opens when Builder runs', inner));
    const compact = height - header.length - footer.length < 12;
    if (compact) {
      header = height >= 7 ? [this.color('FADE') + muted(height < 11 ? ' · small terminal · resize or /pi' : ` · ${this.view.focus} focused · ${visibleText(basename(this.app.store.workspace))}`)] : [];
      footer = [truncateToWidth('Now ' + projection.now, inner), ...(urgent ? [...wrapTextWithAnsi(visibleText(`${urgent.role}: ${urgent.cause}`, 2000), inner).slice(0, height >= 11 ? 2 : 1), truncateToWidth(compactRecovery, inner)] : this.error ? [truncateToWidth(this.error, inner)] : []),
        ...(!hasMenu && height >= 14 ? [truncateToWidth(`Run ${projection.remaining} left · Cost unknown · /status`, inner)] : []),
        truncateToWidth(hasMenu ? '↑↓ commands · Tab accepts · Escape closes' : `${this.switchKey} pane · /status · /pi`, inner)];
      if (height < 10) footer = height >= 8 && urgent ? [truncateToWidth('Now ' + projection.now, inner), truncateToWidth(urgent.cause, inner), truncateToWidth(compactRecovery, inner)]
        : height >= 4 ? [truncateToWidth(urgent ? compactRecovery + ' · ' + urgent.cause : 'Now ' + projection.now + ' · /status', inner)] : [];
    }
    const paneHeight = Math.max(1, height - header.length - footer.length);
    let body: string[];
    // Fade shows the split workspace for any ongoing project (running, paused or interrupted slice),
    // not only while a slice is actively running — otherwise Fade mode looks identical to Companion.
    if (this.view.mode === 'fade' && active && width >= 110) {
      const left = Math.floor((inner - 3) / 2), right = inner - left - 3;
      const builder = this.pane('builder', left, paneHeight), companion = this.pane('companion', right, paneHeight);
      body = builder.map((line, index) => line + muted(' │ ') + (companion[index] ?? ' '.repeat(right)));
    } else {
      // Narrow Fade shows the focused pane; explain the difference instead of silently mirroring the roles.
      body = this.pane(this.view.mode === 'fade' ? this.view.focus : this.view.mode, inner, paneHeight);
    }
    const lines = [...header, ...body, ...footer];
    return lines.map(line => {
      const padded = ' '.repeat(padding) + truncateToWidth(renderedText(line).replace(/\n/g, ' '), inner, '…', true) + ' '.repeat(padding);
      return process.env.NO_COLOR !== undefined ? padded.replace(/\x1b\[[0-9;]*m/g, '') : this.theme.bg('customMessageBg', this.theme.fg('text', padded));
    });
  }
  invalidate(): void { this.editors.builder.invalidate(); this.editors.companion.invalidate(); }
  /** Restore native root/focus through public APIs before a native command or dialog. */
  restore(): void {
    if (this.disposed) return;
    this.flush(); this.nativeAdapter.restore();
  }
  dispose(): void { if (!this.disposed) this.restore(); }
}
