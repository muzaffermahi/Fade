import { CURSOR_MARKER, isFocusable, type Component, type Focusable, type TuiMouseEvent } from '@earendil-works/pi-tui';
import type { AgentToolResult } from '@earendil-works/pi-coding-agent';

/** One display boundary: raw stored text is never changed by terminal sanitization. */
export function terminalText(value: string, limit = 2000): string { return sanitize(value, limit, false); }
/** Native composer output may contain theme SGR and Pi's public cursor marker, never terminal actions. */
export function renderedText(value: string): string { return sanitize(value, 500000, true); }
/** Delegate public component behavior, filtering only the lines returned to the existing renderer. */
export function displayComponent(component: Component): Component {
  return isFocusable(component) ? new FocusedDisplay(component) : new SafeDisplay(component);
}
/** Preserve the delegate's cache identity across presentation wrappers. */
export function underlyingComponent(component: Component | undefined): Component | undefined {
  let current = component; while (current instanceof SafeDisplay) current = current.source; return current;
}
/** Bounded presentation copies; execution arguments, raw results and image data remain outside this transform. */
export function displayValue(value: unknown): unknown {
  let nodes = 512, characters = 500000;
  const visit = (entry: unknown, depth: number): unknown => {
    if (--nodes < 0 || depth > 8) return '[Display metadata truncated]';
    if (typeof entry === 'string') { const text = terminalText(entry, Math.max(0, characters)); characters -= text.length; return text + (entry.length > text.length && characters <= 0 ? '[Display text truncated]' : ''); }
    if (entry instanceof Uint8Array) return '[Binary metadata omitted from display]';
    if (Array.isArray(entry)) return entry.slice(0, 128).map(item => visit(item, depth + 1)).concat(entry.length > 128 ? ['[Display items truncated]'] : []);
    if (entry && typeof entry === 'object') {
      const fields = Object.entries(entry), selected = fields.slice(0, 128).map(([key, item]) => [terminalText(key, 2000), visit(item, depth + 1)]);
      if (fields.length > 128) selected.push(['[Display fields truncated]', fields.length - 128]);
      return Object.fromEntries(selected);
    }
    return entry;
  };
  return visit(value, 0);
}
type DisplayJson = Exclude<AgentToolResult<unknown>['structuredContent'], undefined>;
/** Typed structured-content display copy; no cast widens the SDK's JSON contract. */
export function displayJson(value: DisplayJson): DisplayJson {
  let nodes = 512, characters = 500000;
  const visit = (entry: DisplayJson, depth: number): DisplayJson => {
    if (--nodes < 0 || depth > 8) return '[Display metadata truncated]';
    if (typeof entry === 'string') { const text = terminalText(entry, Math.max(0, characters)); characters -= text.length; return text; }
    if (entry === null || typeof entry === 'number' || typeof entry === 'boolean') return entry;
    if (Array.isArray(entry)) return entry.slice(0, 128).map(item => visit(item, depth + 1)).concat(entry.length > 128 ? ['[Display items truncated]'] : []);
    const result: Record<string, DisplayJson> = {}, fields = Object.entries(entry);
    for (const [key, item] of fields.slice(0, 128)) Object.defineProperty(result, terminalText(key, 2000), { value: visit(item, depth + 1), enumerable: true, configurable: true, writable: true });
    if (fields.length > 128) result['[Display fields truncated]'] = fields.length - 128;
    return result;
  };
  return visit(value, 0);
}
class SafeDisplay implements Component {
  constructor(protected readonly component: Component) {}
  get source(): Component { return this.component; }
  render(width: number): string[] { return this.component.render(width).map(renderedText); }
  invalidate(): void { this.component.invalidate(); }
  handleInput(data: string): void { this.component.handleInput?.(data); }
  handleMouse(event: TuiMouseEvent) { return this.component.handleMouse?.(event); }
  get wantsKeyRelease(): boolean { return this.component.wantsKeyRelease ?? false; }
}
class FocusedDisplay extends SafeDisplay implements Focusable {
  constructor(private readonly target: Component & Focusable) { super(target); }
  get focused(): boolean { return this.target.focused; }
  set focused(value: boolean) { this.target.focused = value; }
}

function sanitize(value: string, limit: number, presentation: boolean): string {
  let result = '', visible = 0, offset = 0;
  const append = (text: string): boolean => {
    if (visible + text.length > limit) return false;
    result += text; visible += text.length; return true;
  };
  while (offset < value.length && visible < limit) {
    if (value.startsWith(CURSOR_MARKER, offset)) { if (presentation) result += CURSOR_MARKER; offset += CURSOR_MARKER.length; continue; }
    const code = value.codePointAt(offset); if (code === undefined) break;
    if (code === 0x1b || code === 0x9b || [0x90, 0x98, 0x9d, 0x9e, 0x9f].includes(code)) {
      const escape = code === 0x1b, next = escape ? value[offset + 1] : undefined;
      if ((escape && next === '[') || code === 0x9b) {
        const start = offset; offset += escape ? 2 : 1;
        while (offset < value.length && !/[\x40-\x7e]/.test(value[offset] ?? '')) offset++;
        if (offset < value.length) offset++;
        const sequence = value.slice(start, offset);
        // Conceal, blink and arbitrary controls are not supported presentation.
        if (presentation && /^\x1b\[[\d;]*m$/.test(sequence) && safeSgr(sequence)) result += sequence;
      } else if ((escape && next !== undefined && ']PX^_'.includes(next)) || !escape) {
        const osc = next === ']' || code === 0x9d; offset += escape ? 2 : 1;
        while (offset < value.length) {
          if (value.charCodeAt(offset) === 0x9c || (osc && value.charCodeAt(offset) === 7)) { offset++; break; }
          if (value[offset] === '\x1b' && value[offset + 1] === '\\') { offset += 2; break; }
          offset++;
        }
      } else {
        offset++;
        while (offset < value.length && /[\x20-\x2f]/.test(value[offset] ?? '')) offset++;
        if (offset < value.length && /[\x30-\x7e]/.test(value[offset] ?? '')) offset++;
      }
      continue;
    }
    const character = String.fromCodePoint(code); offset += character.length;
    if (code === 13) { if (value[offset] !== '\n' && !append('[CR]')) break; continue; }
    if (code === 9) { if (!append('    ')) break; continue; }
    if (code < 32 && code !== 10 || code >= 0x7f && code <= 0x9f) continue;
    if ([0x061c, 0x200e, 0x200f].includes(code) || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069) {
      if (!append(`[U+${code.toString(16).toUpperCase().padStart(4, '0')}]`)) break;
    } else if (!append(character)) break;
  }
  return result;
}
function safeSgr(sequence: string): boolean {
  const values = sequence.slice(2, -1).split(';').map(value => value ? Number(value) : 0);
  for (let offset = 0; offset < values.length; offset++) {
    const value = values[offset]; if (value === undefined) return false;
    if ([38, 48, 58].includes(value)) {
      const mode = values[++offset], channels = mode === 2 ? 3 : mode === 5 ? 1 : 0;
      if (!channels) return false;
      for (let n = 0; n < channels; n++) { const channel = values[++offset]; if (channel === undefined || channel < 0 || channel > 255) return false; }
    } else if (![0, 1, 2, 3, 4, 7, 9, 22, 23, 24, 27, 29, 39, 49, 59].includes(value)
      && !(value >= 30 && value <= 37 || value >= 40 && value <= 47 || value >= 90 && value <= 107)) return false;
  }
  return true;
}
