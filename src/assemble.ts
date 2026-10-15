import { Git } from './git.js';
import { Fade } from './loop.js';
import { PlanStore } from './plan.js';
import { StateStore } from './state.js';
import type { BuilderAgent, CompanionAgent, PlanApi } from './types.js';

export interface Agents {
  builder: BuilderAgent;
  companion: CompanionAgent;
}

/** The Companion's view of the plan. Cards it writes become the "ready it?" suggestion. */
export function companionPlanApi(need: () => Fade): PlanApi {
  return {
    list: () => need().list(),
    addCard: (title, body) => need().proposeCard(title, body),
    editCard: (title, patch) => need().editCard(title, patch, true),
    goal: () => need().model.plan.goal,
    setGoal: text => need().setGoal(text),
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
