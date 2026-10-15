# Fade 0.5.0 final-pass results

Baseline: `833996b` — Fade v0.4: just talk to it. This is the only source-repository commit authorized
and created for this pass. Later changes remain uncommitted. No push, publication or launch post.
The owner explicitly retained Builder MCP, codemode and tool_search and authorized completing
available work while marking macOS/human gates pending.

## Implemented

- Stable 88-column conversation; rail uses spare width, compact row stays stable at narrow widths.
- Deterministic work replies, normalized titles, duplicate acknowledgement suppression, example prompts.
- Mint verified tick and faint checked badge; hollow not-checked outcomes, consistent Show/rail wording.
- Shorter prompts, readable source, dead progress/log/control plumbing removed. Legacy Goal text round-trips
  as preamble. Archived run output stays: git show cannot reconstruct actual check results.
- Explicit extension loading keeps bundled web access and native Builder MCP/codemode/discovery;
  unrelated global/project Pi extensions are not autoloaded. Skills/templates still pass through.
- Dirty-launch heads-up, one-time current-branch commit notice, graceful stop on quit, clear paused
  recovery, and deterministic continue for a single paused/failed request. Continue never accepts failure.
- Successful executed checks settle a criterion even when a model also supplies a look; actual unanswered
  taste criteria still wait for the human. Failures remain recorded and do not quietly land.
- Version 0.5.0, model-pair guidance, concise README, current launch drafts and a real terminal demo GIF.
- One live-smoke script supports web/python/conversation/all; stale scripts/docs are removed or folded.

## Observed checks

- Phase 0: clean baseline commit; 86 tests, typecheck and build passed.
- Phase 1: Windows PTY demo completed checked work, direction choice, yes acceptance and undo with
  conversation replies. Render regression covers identical transcript wrapping/height across activity.
- Web: real search/fetch passed with isolated extensions; Builder codemode/tool_search and focused
  diagnostics remain available, while Fade's voice excludes shell/edit/arbitrary MCP.
- Python: Kimi voice plus Flash Builder repaired a real Python function, independently reran its test,
  and quietly landed. Evidence: output/final-pass-python-isolated.txt.
- Conversation: Kimi/Kimi completed version → verified landing → undo → direction question → ordinal
  choice → human look → yes. Evidence: output/final-pass-conversation-complete.txt.
- Linux: clean package installation on Node 22.19.0, real sh command execution and a full PTY demo passed.
  The GIF records that actual 25-second flow; it is not a simulated screen. Demo inputs wait for results.
- Windows: clean package installation passed. The automated suite covers timeout/process-tree cleanup,
  cancellation, one retry, failed hooks/checkpoints, preserved check output and double Ctrl+C.

## Dirty upstream clone rehearsal

Used a real strip-bom clone with an existing README edit. Launch showed the dirty-tree warning and
current-main checkpoint notice. Quit mid-build saved partial checkpoints and a clearly stopped result;
relaunch preserved the work and commit notice was not repeated. Continue behavior was corrected after
one model attempted to treat continue as acceptance; a deterministic regression now prevents that path.

The first clone was under an unrelated parent workspace and inherited its @types packages, breaking
upstream type checks. A separate temp clone removed that contamination. Actual named-export behavior
and its later removal were independently checked. The upstream npm test command also exposed an
existing ESLint/XO crash under this environment; Fade recorded it as failed rather than checked.
Therefore the full upstream clean-test gate is **not claimed passed**. The early recovery driver printed
an overly broad PASS after checking runtime behavior alone; the recorded failed review is authoritative.
All dirty/partial commits remain recoverable in the disposable fixture Git history. As disclosed at launch,
the first checkpoint includes pre-existing edits; undoing that checkpoint can revert those edits too.

Local evidence: output/final-pass-recovery-isolated.txt, output/final-pass-recovery-outside.txt,
and output/final-pass-dirty-clone/.fade/. No upstream project was changed outside disposable clones.

## External gates

- macOS Terminal/iTerm: implementation uses the same portable sh path; an actual macOS run is pending.
- Fresh human/user account reaching a checked real-project result within five minutes: not measured.
- Five-person hallway study, top-five observed fixes and two-person repeat: pending; protocol and blank
  observation sheet are in hallway-test.md. No invented observations or success rates.
- npm publication and launch posting: owner approval/action pending. Local package rehearsal is separate.

## Final command results

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json`: passed.
- `node --import tsx --test --test-timeout=60000 tests/*.test.ts`: 91 passed, zero failures/skips.
- `node --import tsx scripts/snapshot.ts`: passed; wide/narrow, empty/building/waiting states inspected.
- `node node_modules/typescript/bin/tsc -p tsconfig.json`: passed.
- Release build into fresh staging dist plus `npm pack`: passed; 110 files, no stale compiled modules.
- Clean Windows and Linux npm installs: passed. Linux Node 22.19.0 real sh run: passed.
- `npx --yes ./fade.tgz --version` in a separate temp project: printed 0.5.0.
- `npx --yes ./fade.tgz --demo`: launched the packaged UI with the three examples; checked-work flow rehearsed.
- Source-layout check: 3,999 TS source lines, zero lines over 120 characters; rebuild spec is 73 lines.
- `git diff --check`: passed. Local raw command logs remain in output/.

The local artifact is output/muzaffermahi-fade-0.5.0.tgz. Documentation/notice refreshes after the
runtime rehearsal are checked against an unchanged packaged-runtime hash manifest. No npm publish
was attempted. Regenerating the GIF used a real Linux PTY recording plus agg, with readiness/result
checks before input; docs/demo.tape is also updated for VHS users.

## Files changed since the baseline

```text
AGENTS.md
README.md
THIRD_PARTY_NOTICES.md
docs/assets/demo.gif
docs/changelog.md
docs/demo.tape
docs/final-pass-plan.md
docs/final-pass-results.md
docs/hallway-test.md
docs/launch/posts.md
docs/rebuild-plan.md
docs/v0.3-slice-a-live-test.md
docs/v0.4-validation.md
package-lock.json
package.json
scripts/capabilities-smoke.ts
scripts/conversation-smoke.ts
scripts/headless.ts
scripts/live-smoke.ts
scripts/perf.ts
scripts/python-smoke.ts
scripts/snapshot.ts
src/agents/builder.ts
src/agents/checks.ts
src/agents/companion.ts
src/agents/fake.ts
src/agents/pi.ts
src/agents/prompts.ts
src/agents/slash.ts
src/assemble.ts
src/cli.ts
src/companion-chat.ts
src/demo.ts
src/engine.ts
src/git.ts
src/loop.ts
src/plan-model.ts
src/plan.ts
src/proof.ts
src/state.ts
src/types.ts
src/ui/app.ts
src/ui/box.ts
src/ui/commands.ts
src/ui/companion-pane.ts
src/ui/logo.ts
src/ui/overlays.ts
src/ui/pane.ts
src/ui/rail.ts
src/ui/screen.ts
src/ui/splash.ts
src/ui/start.ts
src/ui/strip.ts
src/ui/theme.ts
src/verdict.ts
src/view.ts
tests/errors.test.ts
tests/loop.test.ts
tests/plan.test.ts
tests/render.test.ts
tests/thread.test.ts
tests/verdict.test.ts
```
