# Fade

Read docs/rebuild-plan.md first. It is the only spec.

- Build only the current phase. Stop at its "Try it" check and report how to try it.
- Every change must be something a user can see or feel. If you can't demo it, don't build it.
- Source budget for v0.1 is ~2,000 lines. Over budget means simplify, not expand.
- Write plain, readable TypeScript: normal line lengths, one statement per line, small functions.
- No new concepts, states or safety machinery beyond the plan. Pi's slash commands are supported on purpose. Git is the undo.
- When a UX choice is unclear, pick the simpler one and say so in your report.
- Tests: plan parser, loop transitions, render snapshots. Nothing else unless asked.
- Don't commit, push or publish unless the human asks.
