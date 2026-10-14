import { type Editor } from '@earendil-works/pi-tui';
import type { FadeView } from '../loop.js';
import { editorBlock, paneHeader, viewport, withNewHint, type PaneOptions } from './pane.js';
import { bold, c, clock, GLYPH, sanitize, spinnerFrame, wrap } from './theme.js';

export interface BuilderPaneOptions extends PaneOptions {
  rawLog: boolean;
}

const MAX_MESSAGE_LINES = 6;
const MAX_NOTES = 3;

function stepLines(view: FadeView, now: number): string[] {
  const lines: string[] = [];
  for (const step of view.building?.steps ?? []) {
    const text = sanitize(step.text);
    if (step.status === 'done') lines.push(` ${c.mint(GLYPH.done)} ${c.text(text)}`);
    else if (step.status === 'active') lines.push(` ${c.mint(spinnerFrame(now))} ${bold(c.text(text))}`);
    else lines.push(` ${c.faint('○')} ${c.faint(text)}`);
  }
  const action = view.building?.action;
  if (action) lines.push(`   ${c.muted(`└ ${sanitize(action)}`)}`);
  return lines;
}

function messageLines(view: FadeView, width: number): string[] {
  const text = view.building?.liveText || view.building?.lastMessage || '';
  if (!text.trim()) return [];
  const wrapped = wrap(text.trim(), width - 2).slice(-MAX_MESSAGE_LINES);
  return ['', ...wrapped.map(line => ` ${c.text(line)}`)];
}

function noteLines(view: FadeView, width: number): string[] {
  const notes = view.building?.notes.slice(-MAX_NOTES) ?? [];
  if (notes.length === 0) return [];
  const out = [''];
  for (const note of notes) {
    const wrapped = wrap(note, width - 8);
    wrapped.forEach((line, i) => out.push(` ${i === 0 ? c.lavender('you ›') : '     '} ${c.text(line)}`));
  }
  return out;
}

function errorLines(view: FadeView, width: number): string[] {
  if (!view.builderError) return [];
  return ['', ...wrap(view.builderError, width - 2).map(line => ` ${c.rose(line)}`)];
}

function idleLines(view: FadeView, width: number): string[] {
  const hasReady = view.cards.some(card => card.state === 'ready');
  const say = (text: string): string[] => wrap(text, width - 2).map(line => ` ${c.muted(line)}`);
  if (view.builderError) return ['', ...errorLines(view, width).slice(1), '', ...say('Type a task below to try again.')];
  if (hasReady) return ['', ` ${c.text('Builder is paused.')}`, ...say('Type a task below to carry on with the ready cards.')];
  return ['', ` ${c.text('Builder is free.')}`, ...say('Type a task below, or mark a card ready (tab → plan, space).')];
}

export function builderPane(view: FadeView, o: BuilderPaneOptions, editor: Editor): string[] {
  const input = editorBlock(editor, o.width, o.focused, 'note to builder…');
  const bodyHeight = Math.max(0, o.height - 1 - input.length);
  const building = view.building;
  const title = building ? `  ${c.text(sanitize(building.title))}` : '';
  const right = building ? c.mint(`${spinnerFrame(o.now)} ${clock(o.now - building.startedAt)}`) : c.muted('idle');
  const header = paneHeader('BUILDER', s => bold(c.mint(s)), o.focused, title, right, o.width);

  let content: string[];
  if (!building) {
    content = idleLines(view, o.width);
  } else if (o.rawLog) {
    const log = view.builderLog.slice(-Math.max(1, bodyHeight));
    content = [...stepLines(view, o.now), '', ...log.map(line => ` ${c.faint(sanitize(line))}`)];
  } else {
    content = [...stepLines(view, o.now), ...messageLines(view, o.width), ...noteLines(view, o.width), ...errorLines(view, o.width)];
  }
  const shown = viewport(content, bodyHeight, o.scroll);
  return [header, ...withNewHint(shown.lines, shown.behind, o.width), ...input];
}
