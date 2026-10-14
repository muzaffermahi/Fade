import { Git } from './git.js';
import { Fade } from './loop.js';
import { PlanStore } from './plan.js';
import { StateStore } from './state.js';
import type { BuilderAgent, CompanionAgent, PlanApi } from './types.js';

export interface Agents {
  builder: BuilderAgent;
  companion: CompanionAgent;
}

export function assemble(cwd: string, makeAgents: (plan: PlanApi) => Agents): Fade {
  const holder: { fade?: Fade } = {};
  const need = (): Fade => {
    if (!holder.fade) throw new Error('Fade is not ready yet.');
    return holder.fade;
  };
  // The Companion needs the plan before Fade exists, so it talks to Fade through this forwarder.
  const planApi: PlanApi = {
    list: () => need().list(),
    addCard: (title, body) => need().addCard(title, body),
    editCard: (title, patch) => need().editCard(title, patch),
  };
  const { builder, companion } = makeAgents(planApi);
  holder.fade = new Fade({ cwd, plans: new PlanStore(cwd), state: new StateStore(cwd), git: new Git(cwd), builder, companion });
  return holder.fade;
}
