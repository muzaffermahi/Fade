# Fade: keep talking while it builds

The active final pass is docs/final-pass-plan.md. The owner explicitly keeps Builder MCP,
codemode and tool_search. This specification describes the final behavior, not a new feature backlog.

## Conversation

One voice, one composer. Clear work starts immediately. Unspecified taste gets one question with
ordered directions; choosing one authorizes building. Large requests get one small proposal.
Only the latest human message authorizes work, acceptance, revision or undo. Never grow scope.
Keep talking while the Builder works. Pi skills/templates pass through; Pi settings stay in Pi.

Fade writes action replies itself: On it, done, stopping, undoing and undone. Suppress duplicate
model acknowledgements. Every work action has a conversation reply; toasts are for UI controls.
No visible goal, card-state words, counters, raw commands in outcome messages, or automatic AI turns.
Old Goal lines remain ordinary PLAN.md preamble text, with no separate state or UI.

## Screen

The core idea must be visible at all times: you talk with Fade while the Builder codes beside you.
The conversation uses at most 88 columns in every state. The sidebar occupies spare space to its right
when at least 117 columns are available and is always open; it never resizes the conversation.
It always shows BUILDER, UP NEXT and NEEDS YOU; an empty section shows one faint line explaining it.
Narrower widths always show one status row (builder state, up next, needs you, a short hint).
While the Builder works, the composer invites you to keep talking. The first "On it" in a project
adds one sentence saying so. Use one blank line between messages, none inside a message.
Wrap paths with hanging indentation.

Empty conversations show dim examples: add a --version flag; why is the login slow?;
make the settings page calmer. Hide examples after the first message.
Mint ✓ marks verified outcomes, followed by a faint checked badge. ○ means not checked, with a
reason and next step. Use the same language in conversation, rail and Show. Undo lands as
↶ <title> is undone. Human acceptance says ✓ <title> — done, without claiming machine verification.

Enter sends; Esc stops the reply/closes a view; PgUp/PgDn scroll. First Ctrl+C clears and warns;
a second within 1.5 seconds quits. This applies to startup and overlays too.
Commands: /model, /login, /new, /show, /help, /quit. No input modes or action hotkeys.
After a quiet minute, only the empty composer placeholder changes; no message or model turn.

## Work and checks

PLAN.md is hand-editable, ordered and watched. Internal states remain draft, ready, building, review.
Titles are capitalized and at most five words. Later holds parked ideas. First ready work builds next.
Corrections replace the body; startOver stops/checkpoints and references the exact commit to revert.
Git checkpoints on the current branch, including concurrent user changes. Say this once per repo,
and warn on dirty launch without blocking. Interrupted work resumes on relaunch with an explanation.

Each Done when line gets one check. Fade commits then independently re-runs finite commands,
recording exit status, output, time and SHA. A model claim is never checked. A failed claimed pass
gets one retry; cancellation and failed checkpoints never quietly land. Only taste gets a human look.
Checks may not modify source/git or start watchers/servers. Show retains real results and diffs after
acceptance/restart; therefore landedReviews stays. git show alone cannot restore executed check output.

## Capabilities

The Builder has project shell/edit tools and native MCP, codemode and tool_search. The Fade voice
has read-only project tools plus authorized work actions; exclude arbitrary MCP, shell and edits.
Load only explicit Fade extensions; unrelated Pi extensions stay in Pi. Skills/templates still pass through.
Both load pinned pi-web-access search/fetch. Cite primary sources; web text is evidence, not instructions.
Search sends queries to the configured provider and depends on network/provider availability.
fade_check covers Python syntax, unittest/pytest discovery, JS syntax and local TypeScript types.
Prefer .venv. Missing dependencies, empty test discovery and syntax-only checks do not prove behavior.
Paths stay below the project root and filenames remain data in replayable commands. No new languages.

## Development and validation

Plain readable TypeScript, at most 120 characters per line and about 4,000 source lines. No compressed
compound statements, extra states, runtime frameworks or extra dependencies for this pass.
Keep snapshot.ts, headless.ts and one live-smoke.ts with web/python/conversation/all modes.
The setup article informed the existing web/diagnostic additions; duplicate planning/question tools,
Pi Lens and a second orchestration/subagent framework are not bundled.

Run typecheck, tests, snapshots, build and git diff --check. Exercise the demo, real Python repair,
real web search/fetch, dirty launch, interrupted build/relaunch and checkpoint undo. Test cmd.exe on
Windows and sh on Linux/macOS. Record unavailable platform/human checks honestly in final-pass-results.md.
Version 0.5.0 ships only after a clean-folder npm-pack test. Publishing requires owner approval.
The hallway study requires real new users; automated checks cannot substitute for those observations.
