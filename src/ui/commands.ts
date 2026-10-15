import type { Component, SlashCommand } from '@earendil-works/pi-tui';
import type { Fade } from '../loop.js';
import type { SlashResult } from '../types.js';
import { ModelPickerOverlay } from './overlays.js';
import type { UiMeta } from './screen.js';

export interface CommandHost {
  readonly fade: Fade;
  readonly meta: UiMeta;
  readonly quit: () => void;
  readonly rows: () => number;
  toast(text: string): void;
  show(component: Component): void;
  close(): void;
  openHelp(): void;
  openShow(title?: string): void;
  refreshCommands(): void;
}
export const APP_COMMANDS: SlashCommand[] = [
  { name: 'model', description: 'Choose Builder or Fade model', argumentHint: '[builder|fade] [provider/model]' },
  { name: 'login', description: 'Connect a provider with Pi' },
  { name: 'new', description: 'Start a fresh Fade conversation' },
  { name: 'show', description: 'Summary, checks, files and diff', argumentHint: '[title]' },
  { name: 'help', description: 'Help' }, { name: 'quit', description: 'Quit Fade' },
];

function applyResult(host: CommandHost, which: 'builder' | 'companion', result: SlashResult): void {
  if (result.kind === 'prompt') return host.fade.sendToCompanion(result.text);
  if (result.kind === 'info') return host.toast(result.text);
  if (result.kind === 'pick-model') {
    const agent = host.fade.slashHost(which);
    if (!agent) return;
    host.show(new ModelPickerOverlay(host.rows, which === 'builder' ? 'Builder' : 'Fade', result.models, result.current, selector => {
      host.close();
      void agent.setModel(selector).then(r => applyResult(host, which, r)).catch(e => host.toast(String(e)));
    }, () => host.close()));
    return;
  }
  if (result.model) {
    if (which === 'builder') host.meta.builderModel = result.model;
    else host.meta.companionModel = result.model;
  }
  if (result.newSession && which === 'companion') host.fade.clearCompanionChat();
  host.toast(result.text);
}

export async function runSlash(host: CommandHost, text: string): Promise<void> {
  const [name = '', ...rest] = text.slice(1).split(/\s+/);
  let args = rest.join(' ');
  if (name === 'help') return host.openHelp();
  if (name === 'quit') return host.quit();
  if (name === 'show') return host.openShow(args || undefined);
  if (name === 'model' && !args) {
    host.show(new ModelPickerOverlay(host.rows, 'Choose whose', ['builder', 'fade'], 'fade', role => {
      host.close();
      void runSlash(host, `/model ${role}`);
    }, () => host.close()));
    return;
  }
  let which: 'builder' | 'companion' = 'companion';
  if (name === 'model' && /^(builder|fade)( |$)/.test(args)) {
    which = args.startsWith('builder') ? 'builder' : 'companion';
    args = args.replace(/^(builder|fade)\s*/, '');
    text = `/model${args ? ` ${args}` : ''}`;
  }
  const agent = host.fade.slashHost(which);
  if (!agent) return host.toast('Model commands need a real model; demo uses fakes.');
  try {
    applyResult(host, which, await agent.run(text));
  } catch (error) {
    host.toast(String(error));
  }
  host.refreshCommands();
}
