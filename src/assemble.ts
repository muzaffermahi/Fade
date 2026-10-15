import { Git } from './git.js';
import { Fade } from './loop.js';
import { PlanStore } from './plan.js';
import { StateStore } from './state.js';
import type { BuilderAgent, CompanionAgent, PlanApi } from './types.js';

export interface Agents {
  builder: BuilderAgent;
  companion: CompanionAgent;
}

/** Fade's card and work actions, forwarded to the engine. */
export function companionPlanApi(need: () => Fade): PlanApi {
  return {
    list: () => need().list(),
    queue: (title, body) => need().queue(title, body),
    ready: title => need().ready(title),
    noteBuilder: text => need().noteBuilder(text),
    stopBuilder: () => need().stopBuilder(),
    accept: title => need().accept(title),
    revise: (title, body, startOver) => need().revise(title, body, startOver),
    undo: title => need().undo(title),
    show: title => need().show(title),
    move: (title, toTop) => need().move(title, toTop),
    addCard: (title, body) => need().proposeCard(title, body),
    editCard: (title, patch) => need().editCard(title, patch),
    later: () => [...need().model.plan.later],
    park: text => need().park(text),
    promote: (item, title, body) => need().promote(item, title, body),
  };
}

export function assemble(cwd: string, makeAgents: (plan: PlanApi) => Agents): Fade {
  const holder: { fade?: Fade } = {};
  const need = (): Fade => {
    if (!holder.fade) throw new Error('Fade is not ready yet.');
    return holder.fade;
  };
  // The Companion needs the plan before Fade exists, so it talks to Fade through this forwarder.
  const { builder, companion } = makeAgents(companionPlanApi(need));
  holder.fade = new Fade({ cwd, plans: new PlanStore(cwd), state: new StateStore(cwd), git: new Git(cwd), builder, companion });
  return holder.fade;
}
