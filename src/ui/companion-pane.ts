import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui';
import type { FadeView } from '../view.js';
import type { TranscriptEntry } from '../types.js';
import { viewport, withNewHint, type PaneOptions } from './pane.js';
import { bold, c, sanitize, underline, wrap } from './theme.js';

const LABEL_WIDTH = 5;
const INDENT = ' '.repeat(LABEL_WIDTH + 2);
/** Room kept free on the right so replies don't run into the pane edge. */
const RIGHT_MARGIN = 2;

const markdownTheme: MarkdownTheme = {
  heading: text => bold(c.mint(text)),
  link: text => underline(c.lavender(text)),
  linkUrl: text => c.faint(text),
  code: text => c.lavender(text),
  codeBlock: text => c.muted(text),
  codeBlockBorder: text => c.faint(text),
  quote: text => c.muted(text),
  quoteBorder: text => c.faint(text),
  hr: text => c.faint(text),
  listBullet: text => c.mint(text),
  bold: text => bold(text),
  italic: text => `\x1b[3m${text}\x1b[23m`,
  strikethrough: text => `\x1b[9m${text}\x1b[29m`,
  underline: text => underline(text),
};

/** Caches one Markdown component per transcript entry so finished replies aren't re-parsed every frame. */
export class CompanionRenderer {
  private cache = new Map<string, Markdown>();

  private markdown(key: string, text: string): Markdown {
    let md = this.cache.get(key);
    if (md && key === 'live') md.setText(sanitize(text));
    if (!md) {
      md = new Markdown(sanitize(text), 0, 0, markdownTheme, { color: c.text });
      if (this.cache.size > 400) this.cache.clear();
      this.cache.set(key, md);
    }
    return md;
  }

  private entryLines(entry: TranscriptEntry, key: string, width: number, view: FadeView): string[] {
    if (entry.role === 'landed' && /^Goal done:/.test(entry.text)) return [];
    const body = Math.max(10, width - LABEL_WIDTH - 2 - RIGHT_MARGIN);
    if (entry.role === 'you' || entry.role === 'companion' || entry.role === 'landed') {
      const label = entry.role === 'you' ? c.lavender('you'.padEnd(LABEL_WIDTH)) : c.mint('fade'.padEnd(LABEL_WIDTH));
      const lines = entry.role === 'you'
        ? wrap(entry.text, body).map(line => c.text(line))
        : this.markdown(key, entry.text).render(body);
      return lines.map((line, i) => ` ${i === 0 ? label : ' '.repeat(LABEL_WIDTH)} ${line}`);
    }
    if (entry.role === 'card' || entry.role === 'goal') return [];
    if (entry.role === 'parked') return [`${INDENT}${c.faint(`↷ parked for later: ${sanitize(entry.text)}`)}`];
    if (entry.role === 'tool') return [`${INDENT}${c.faint(sanitize(entry.text))}`];
    return wrap(entry.text, body).map(line => `${INDENT}${c.rose(line)}`);
  }

  transcriptLines(view: FadeView, width: number): string[] {
    const lines: string[] = [];
    view.companion.forEach((entry, i) => {
      const spaced = entry.role === 'you' || entry.role === 'companion' || entry.role === 'landed';
      if (spaced && lines.length > 0) lines.push('');
      lines.push(...this.entryLines(entry, `${i}:${entry.text.length}:${entry.text.slice(0, 40)}`, width, view));
    });
    if (view.companionLive) {
      if (lines.length > 0) lines.push('');
      lines.push(...this.entryLines({ role: 'companion', text: view.companionLive }, 'live', width, view));
    }
    return lines;
  }

  render(view: FadeView, o: PaneOptions): string[] {
    const content = view.companion.length === 0 && !view.companionLive
      ? ['', ` ${c.text('What are we making?')}`, ` ${c.muted('Tell Fade what you want. I will ask if I need more.')}`]
      : this.transcriptLines(view, o.width);
    const shown = viewport(content, o.height, o.scroll);
    return withNewHint(shown.lines, shown.behind, o.width);
  }
}
