import { Markdown, type Editor, type MarkdownTheme } from '@earendil-works/pi-tui';
import type { FadeView } from '../view.js';
import type { TranscriptEntry } from '../types.js';
import { wordmark } from './logo.js';
import { editorBlock, paneHeader, viewport, withNewHint, type PaneOptions } from './pane.js';
import { bold, c, GLYPH, sanitize, underline, wrap } from './theme.js';

const LABEL_WIDTH = 11;
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

  /** A step the Companion proposed, drawn with its live state. The fresh one says how to ready it. */
  private cardLines(title: string, view: FadeView, body: number): string[] {
    const card = view.cards.find(cd => cd.title === title);
    if (!card) {
      const shipped = view.done.some(entry => entry.title === title);
      return [`${INDENT}${c.faint(`${shipped ? GLYPH.done : '+'} ${sanitize(title)}`)}`];
    }
    const glyph = card.state === 'review' ? c.lavender(GLYPH.review) : card.state === 'draft' ? c.faint(GLYPH.draft) : c.mint(GLYPH[card.state]);
    const fresh = view.freshDraft === title ? `   ${c.text('⏎')} ${c.muted('ready it')}` : '';
    const first = `${INDENT}${glyph} ${bold(c.text(sanitize(card.title)))} ${c.muted(`· ${card.state}`)}${fresh}`;
    const summary = (card.body.split('\n').find(line => line.trim() && !/^done when:/i.test(line.trim())) ?? '').trim();
    const rest = summary ? wrap(summary, body - 2).slice(0, 2).map(line => `${INDENT}  ${c.faint(line)}`) : [];
    return [first, ...rest];
  }

  private entryLines(entry: TranscriptEntry, key: string, width: number, view: FadeView): string[] {
    const body = Math.max(10, width - LABEL_WIDTH - 2 - RIGHT_MARGIN);
    if (entry.role === 'you' || entry.role === 'companion') {
      const label = entry.role === 'you' ? c.lavender('you'.padEnd(LABEL_WIDTH)) : c.mint('companion'.padEnd(LABEL_WIDTH));
      const lines = entry.role === 'you'
        ? wrap(entry.text, body).map(line => c.text(line))
        : this.markdown(key, entry.text).render(body);
      return lines.map((line, i) => ` ${i === 0 ? label : ' '.repeat(LABEL_WIDTH)} ${line}`);
    }
    if (entry.role === 'card') return this.cardLines(entry.text, view, body);
    if (entry.role === 'goal') return [`${INDENT}${c.mint('◎')} ${bold(c.mint('Goal:'))} ${c.text(sanitize(entry.text))}`];
    if (entry.role === 'parked') return [`${INDENT}${c.faint(`↷ parked for later: ${sanitize(entry.text)}`)}`];
    if (entry.role === 'tool') return [`${INDENT}${c.faint(sanitize(entry.text))}`];
    return wrap(entry.text, body).map(line => `${INDENT}${c.rose(line)}`);
  }

  transcriptLines(view: FadeView, width: number): string[] {
    const lines: string[] = [];
    view.companion.forEach((entry, i) => {
      const spaced = entry.role === 'you' || entry.role === 'companion';
      if (spaced && lines.length > 0) lines.push('');
      lines.push(...this.entryLines(entry, `${i}:${entry.text.length}:${entry.text.slice(0, 40)}`, width, view));
    });
    if (view.companionLive) {
      if (lines.length > 0) lines.push('');
      lines.push(...this.entryLines({ role: 'companion', text: view.companionLive }, 'live', width, view));
    }
    return lines;
  }

  /** First thing you see: the mark (if there's room and no banner above) and one clear question. */
  emptyLines(view: FadeView, o: PaneOptions): string[] {
    const mark = o.showMark && o.width >= 78 && o.height >= 12 ? ['', ...wordmark(o.width - 2).map(line => ` ${line}`)] : [];
    const say = (text: string): string[] => wrap(text, o.width - 4).map(line => ` ${c.muted(line)}`);
    if (view.goal) {
      return [...mark, '', ` ${c.text('What is the next step?')}`, ...say(`For: ${view.goal}`)];
    }
    return [
      ...mark, '', ` ${c.text('What are we making?')}`,
      ...say('Say it in a sentence. The Companion turns it into a goal and a first step, and the Builder starts as soon as you ready it.'),
    ];
  }

  render(view: FadeView, o: PaneOptions, editor: Editor): string[] {
    const placeholder = view.goal ? 'talk it through… try "suggest the next step"' : 'what are we making?';
    const input = editorBlock(editor, o.width, o.focused, placeholder);
    const bodyHeight = Math.max(0, o.height - 1 - input.length);
    const right = view.companionBusy ? c.lavender('thinking…') : '';
    const header = paneHeader('COMPANION', s => bold(c.lavender(s)), o.focused, '', right, o.width);
    const content = view.companion.length === 0 && !view.companionLive
      ? this.emptyLines(view, { ...o, height: bodyHeight })
      : this.transcriptLines(view, o.width);
    const shown = viewport(content, bodyHeight, o.scroll);
    return [header, ...withNewHint(shown.lines, shown.behind, o.width), ...input];
  }
}
