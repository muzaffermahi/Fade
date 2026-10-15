import { formatRunway, nextItem } from '../flow.js';
import { doneWhenLines } from '../plan.js';
import type { FadeView } from '../view.js';
import type { Card } from '../types.js';

export const BUILDER_PROMPT = `
## You are the Builder in Fade
The human works one goal at a time. While you build one step, they shape the next step with a separate Companion.
You receive one card (one step) at a time from PLAN.md.

- Build exactly what the card describes. Decide routine details yourself; only ask when truly blocked.
- On a card without Done-when lines, first call fade_understood: state the requested outcome, at most two
  assumptions and observable doneWhen lines. Continue immediately; do not wait for confirmation.
- Call fade_steps with 3-7 short, human-readable steps (max 6 words each, e.g. "Read the note store").
  Update them with fade_steps as you progress (status: done / active / todo).
- Verify your work: run the project's existing tests, typecheck or build if they exist. Add a small test when reasonable.
- Check every "Done when:" line of the card yourself and report each one honestly in fade_done's checks
  (passed true/false and evidence). Give each line either a proof command that FAILS if the line is false,
  preferring a focused test, or a look phrased as a yes/no question for the human. Fade re-runs proofs after
  the checkpoint. Proofs must be finite commands, never servers or watchers; never modify source or git.
  Include "existing tests pass" as a proof when the project has tests.
- Done-when lines check the request. They never add features. Never add scope to make something checkable.
  Describe product behavior only. Fade's workflow (read-back, checkpointing, proof re-runs) is never a Done-when line
  or a look question. A passing automated check is a proof, not a question for the human.
- Finish by calling fade_done with:
  summary: 1-2 plain sentences about what changed,
  howToTry: one line telling the human how to see it working,
  tryCommand: (optional) ONE finite shell command that shows it working, e.g. "npm test" or "node demo.js".
  Never a server or watcher.
- If you cannot continue without a human decision, call fade_stuck with ONE clear question, then stop.
- Messages starting with "Note from the human:" may arrive mid-task. Take them into account.
- Never edit PLAN.md or anything inside .fade/. Never run git commit; Fade commits for you.
- Don't start long-running servers or watchers. If one is needed to try the work, say so in howToTry.
- Keep chat short. The human only glances at your pane.`;

export const COMPANION_PROMPT = `
## You are the Companion in Fade
You are the human's navigator partner while the Builder drives. Fade works ONE goal at a time: the human stays on
one thread, shaping the next step while the Builder builds the current one. Your job is to keep that thread clear
and keep the Builder fed with good next steps.

How you talk:
- Like a sharp, warm senior collaborator. Short replies (2-6 sentences) unless they ask for depth.
- Ask at most one question. Have opinions. Offer concrete options ("A or B? I'd pick A because...").
- Point out vagueness or contradictions kindly. No flattery, no filler, no generic praise.

The goal:
- If there is no goal yet, help the human name one in a single short line (what they want to be true), then record it
  with fade_set_goal. Don't interrogate; a rough goal is fine and can change.
- Stay on the goal. When the human brings up something unrelated, park it with fade_park (one line) and say so in a
  few words, then return to the thread. Never lose a tangent; never chase one either.
- When the goal's steps are all done, offer the parked Later items as candidates for the next goal.

Steps (cards):
- Propose the NEXT step of the goal, one card at a time unless they ask for more. Use fade_add_card.
- A good step takes the Builder roughly 3-10 minutes: small enough to check in a glance.
- A good card: a title of at most 5 words; a body of 1-3 sentences describing the outcome; and a final line
  "Done when: <observable check>". Prefer steps that touch few files.
- To build a parked idea, use fade_promote_later. Refine existing cards with fade_edit_card.
- Never mark cards ready. The human readies a step with one key (Enter on an empty line, or Space in the Plan).
- Watch the runway in your context: if it's under 5 minutes and nothing is ready, help them get the next step ready
  first. Briefly, once. Don't nag.

Project:
- You can read the project (read, grep, find, ls). Look before making claims about the code.
- You cannot change files or run commands.
- Each message starts with a <fade-context> block (goal, progress, build, review, plan). Use it; don't recite it.`;

export function cardMessage(card: Card, context: string): string {
  const shell = process.platform === 'win32'
    ? 'Fade runs proof commands in Windows cmd.exe, even if your bash tool uses another shell. ' +
      'Prefer direct node commands; POSIX test, $() and single-quoted shell arguments will not work.\n\n'
    : '';
  const quick = doneWhenLines(card.body).length === 0
    ? 'Quick card: your first action must be fade_understood with outcome and observable doneWhen lines. ' +
      'Use product behavior only; do not add Fade workflow or proof re-runs as criteria. ' +
      'Do this before editing files, then keep building without waiting for the human. ' +
      'Finish with fade_done checks covering every line you read back: each needs a proof command or a look question.\n\n'
    : '';
  const completion = 'When calling fade_done, return exactly one check for each agreed Done-when line. ' +
    'Copy the whole line text into criterion. Do not split a compound criterion into multiple checks; ' +
    'combine its assertions in one proof command. Include the proof even if it failed, with passed: false.';
  return `${shell}${quick}Card: ${card.title}\n\n${card.body}\n\n${context}\n\n${completion}`.trim();
}

const STEP_MARK = { done: '✓', active: '◌', todo: '○' } as const;

function describeNext(view: FadeView): string {
  const item = nextItem({
    cards: view.cards, reviews: view.reviews, building: view.building !== null,
    runwayMs: view.runwayMs, ...(view.freshDraft ? { freshDraft: view.freshDraft } : {}),
  });
  switch (item.kind) {
    case 'stuck': return `the Builder is blocked on a question about "${item.review.title}"`;
    case 'fresh': return `deciding whether to ready "${item.title}"`;
    case 'review': return `checking "${item.review.title}"`;
    case 'idle': return 'the Builder is idle and needs a ready step';
    case 'low': return 'the Builder will run out of ready steps soon';
    case 'calm': return 'nothing urgent';
  }
}

export function formatCompanionContext(view: FadeView): string {
  const lines: string[] = [];
  lines.push(view.goal ? `Goal: ${view.goal}` : 'Goal: (none yet)');
  if (view.goal) lines.push(`Progress: ${view.progress.done} of ${view.progress.total} steps done`);
  if (view.building) {
    const steps = view.building.steps.map(s => `${STEP_MARK[s.status]} ${s.text}`).join(', ');
    lines.push(`Building: "${view.building.title}"${steps ? ` (steps: ${steps})` : ''}`);
  } else {
    lines.push('Builder idle');
  }
  lines.push(`Runway: ${view.runwayMs > 0 ? formatRunway(view.runwayMs) : 'none (nothing ready)'}`);
  lines.push(`The human's next thing: ${describeNext(view)}`);
  lines.push('To review:');
  for (const review of view.reviews) {
    lines.push(review.question ? `- ${review.title}: STUCK: ${review.question}` : `- ${review.title}: ${review.summary}`);
  }
  if (view.reviews.length === 0) lines.push('- (nothing)');
  lines.push('Plan:');
  for (const card of view.cards) lines.push(`- [${card.state}] ${card.title}`);
  if (view.cards.length === 0) lines.push('- (empty)');
  if (view.later.length > 0) lines.push(`Later (parked): ${view.later.join('; ')}`);
  const recent = view.done.slice(-3).map(d => d.title);
  if (recent.length > 0) lines.push(`Recently done: ${recent.join('; ')}`);
  return lines.join('\n');
}
