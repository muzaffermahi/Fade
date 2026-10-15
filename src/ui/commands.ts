// Slash commands typed into either composer. Fade answers its own; everything else goes to that pane's agent.
import type { Component, SlashCommand } from '@earendil-works/pi-tui';
import type { Fade } from '../loop.js';
import type { SlashResult } from '../types.js';
import { InfoOverlay, ModelPickerOverlay } from './overlays.js';
import type { Focus, UiMeta } from './screen.js';

type Pane = 'builder' | 'companion';

/** What the command layer needs from the app. */
export interface CommandHost {
  readonly fade: Fade;
  readonly meta: UiMeta;
  readonly quit: () => void;
  readonly rows: () => number;
  toast(text: string): void;
  show(component: Component): void;
  close(): void;
  openHelp(): void;
  openFirstReview(): void;
  openRecap(): void;
  setFocus(focus: Focus): void;
  refreshCommands(): void;
  handoffPi(command: string, args: string[], reopen: () => Promise<void>, who: string): Promise<void>;
}

export const APP_COMMANDS: SlashCommand[] = [
  { name: 'goal', description: 'Show or set the goal you are working toward', argumentHint: '[goal]' },
  { name: 'later', description: 'Park a thought, or list what is parked', argumentHint: '[thought]' },
  { name: 'plan', description: 'Open the plan' },
  { name: 'review', description: 'Look at the step that landed' },
  { name: 'recap', description: 'What this session shipped' },
  { name: 'bell', description: 'Ring the terminal bell when something needs you', argumentHint: 'on|off' },
  { name: 'hotkeys', description: 'Show keyboard shortcuts' },
  { name: 'help', description: 'Show keyboard shortcuts' },
  { name: 'quit', description: 'Quit Fade' },
];

/** Returns true when Fade handled the command itself. */
function runAppCommand(host: CommandHost, name: string, args: string): boolean {
  const fade = host.fade;
  switch (name) {
    case 'help':
    case 'hotkeys':
      host.openHelp();
      return true;
    case 'quit':
      host.quit();
      return true;
    case 'plan':
      host.setFocus('plan');
      return true;
    case 'review':
      host.openFirstReview();
      return true;
    case 'recap':
      host.openRecap();
      return true;
    case 'goal':
      if (args) {
        fade.setGoal(args);
        host.toast(`Goal: ${args}`);
      } else {
        const goal = fade.view().goal;
        host.toast(goal ? `Goal: ${goal}  (type /goal and a new one to change it)` : 'No goal yet. Type /goal and a sentence.');
      }
      return true;
    case 'later':
      if (args) {
        fade.park(args);
        host.toast('Parked in Later');
      } else {
        const later = fade.view().later;
        const text = later.length > 0 ? later.map(item => `↷ ${item}`).join('\n') : 'Nothing parked.';
        host.show(new InfoOverlay(host.rows, 'Later', text, () => host.close()));
      }
      return true;
    case 'bell': {
      const on = args ? args !== 'off' : !fade.view().bell;
      fade.setBell(on);
      host.toast(on ? 'Bell on: a quiet ding when something needs you' : 'Bell off');
      return true;
    }
  }
  return false;
}

function applyResult(host: CommandHost, which: Pane, name: string, result: SlashResult): void {
  const who = which === 'builder' ? 'Builder' : 'Companion';
  switch (result.kind) {
    case 'prompt':
      host.fade.sendToCompanion(result.text);
      return;
    case 'info':
      host.show(new InfoOverlay(host.rows, `/${name}`, result.text, () => host.close()));
      return;
    case 'pick-model': {
      const agent = host.fade.slashHost(which);
      if (!agent) return;
      host.show(new ModelPickerOverlay(host.rows, who, result.models, result.current, selector => {
        host.close();
        void agent.setModel(selector).then(picked => applyResult(host, which, 'model', picked));
      }, () => host.close()));
      return;
    }
    case 'handoff':
      void host.handoffPi(result.command, result.args, result.reopen, who);
      return;
    case 'toast':
      if (result.model && which === 'builder') host.meta.builderModel = result.model;
      if (result.model && which === 'companion') host.meta.companionModel = result.model;
      if (result.newSession && which === 'companion') host.fade.clearCompanionChat();
      host.toast(result.text);
  }
}

export async function runSlash(host: CommandHost, which: Pane, text: string): Promise<void> {
  const space = text.indexOf(' ');
  const name = (space === -1 ? text.slice(1) : text.slice(1, space)).trim();
  const args = space === -1 ? '' : text.slice(space + 1).trim();
  if (runAppCommand(host, name, args)) return;
  const agent = host.fade.slashHost(which);
  if (!agent) return host.toast('Agent commands need a real model; they are off in --demo.');
  host.toast(`/${name}…`);
  applyResult(host, which, name, await agent.run(text));
  host.refreshCommands();
}
