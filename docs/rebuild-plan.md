# Fade v0.4: Just talk to it

The owner's conversation-polish follow-up supersedes the initial v0.4 goal UI and command-heavy
landing messages. Proof execution, verdicts, one automatic retry, quiet landing and checkpoint undo remain.

## Mental model

**You**, **Fade** (the only voice), and **the Builder you watch**. One composer, one conversation.
Clear requests execute immediately after a one-sentence “On it” read-back. Fuzzy or large requests
get one concrete question or a draft and “Want it?”. Corrections replace the card body; a misunderstanding
uses `startOver: true`, stops active work, checkpoints it and instructs the Builder to revert that exact SHA first.
No separate revision interpreter or Choose syntax.

Five states stay unchanged: draft (idea), ready (queued), building, review (needs you), done.
`PLAN.md` is the ordered, hand-editable source of truth, watched live. The first ready card builds next.
Later ideas stay in PLAN.md. The conversation is the thread: no automatic goals, progress dots or
goal-done announcements. Preserve legacy Goal lines on disk, hidden from UI and model context.
Internal card states and repeated task bodies stay out of conversation, including old transcript entries.

## Authority

Every Companion turn begins with a human message. Queue, ready, accept, revise and undo require the
latest human message to request them. This is a prompt rule and the absence of automatic Companion turns;
landing messages come from code, never trigger a model turn, and never grant authority.
No extra authorization machinery. Never grow scope. Git is the undo.

Companion tools retain read-only project access, add/edit/read/park/promote and add:
`fade_queue(title, body)`, `fade_ready(title)`, `fade_note_builder(text)`, `fade_stop_builder()`,
`fade_accept(title)`, `fade_revise(title, body, startOver)`, `fade_undo(title)`,
`fade_show(title)`, `fade_move(title, toTop)`. Queue appends a ready card. Add proposes a draft.
The Builder no longer calls fade_understood: Fade's response is the read-back.
The Companion context includes current work, full cards, review questions and human look questions.

Before model calls, exact stop stops the Builder, undo undoes the last landed checkpoint, and
 yes/y/go/ok readies a single draft or answers a single waiting question. Ambiguous targets go to Fade.
“undo that” is also accepted by the fast path. Words replace the removed plan and review hotkeys.

## Screen

At 100 columns or wider, the conversation fills the left with a read-only Now / Next / Needs you rail
on the right only while work is building or awaiting the human. Now shows title, elapsed time, steps
and current action. Next shows queued work when present. Needs you shows waiting results/questions
when present. Empty sections disappear. Wrap text and unbroken paths within the panel, retaining
hanging indentation. Narrow windows use a compact active status line. Idle conversations use the
full width. The one-line header contains fade, folder and branch.
The wordmark appears only in the startup splash. The window title signals “Fade · ◆ needs you”.
Bell always rings when a new review arrives. No focus switching, Next attention ranking, runway estimate,
shipped-today counter, recap, goal closure overlay, raw log toggle or park dialog.

Keys: Enter send, Esc stop the reply, PgUp/PgDn scroll, Ctrl+C twice quit. First press clears input
and warns; a second within 1.5 seconds quits. Expiry or new input requires a fresh double press.
The warning applies to overlays and startup too. `?` on an empty line opens help.
Commands: `/model` (Builder or Fade), `/login`, `/new`, `/show`, `/help`, `/quit`.
Pi skills and prompt templates pass through. Pi's handoff screens are removed; run Pi in another terminal.
`/login` directs the user there. Help, ModelPicker and read-only Show are the surviving overlays.
Show contains summary, checks with real passing/failing output, files and diff in one scrollable view.
Quietly accepted reviews remain inspectable, including after restart.

## Landing

Pure `landingMessage(review)` produces conversation entries for verified, look, failed, said, unfinished
and no-check results. Verified messages describe the checked outcome in plain words; shell commands
and actual output belong in Show. Look messages ask the human's
questions. Claimed checks say what Fade could not check and how to try it. Failed claims get one retry
and a message saying so. Stopped or unfinished work invites “continue” or a correction.
After a minute of inactivity, an empty idle composer quietly asks what the human wants next.
This is a placeholder, not a new message or model turn. No automatic focus changes or overlays.

## Useful capabilities

The Builder already has shell execution. Add `fade_check(paths, tests)` for Python syntax and
existing unittest/pytest tests, JavaScript syntax and local TypeScript project diagnostics.
Prefer a project .venv; discover pytest configuration/functions or unittest suites. Missing runtimes,
missing dependencies and zero discovered tests must not count as verified runtime behavior.
Return actual output and replayable proof commands. Resolve requested files below the project root;
filenames remain data, never interpolated shell syntax. Other languages use project-native commands.

Bundle pinned pi-web-access for search, fetch and retrieval in both sessions. Keep search in the
conversation with workflow none. Treat web content as evidence rather than instructions and cite
useful primary sources. Network/provider availability is not guaranteed.
Explicitly load the existing Pi MCP, tool-search and codemode extension factories for the Builder:
SDK sessions do not inherit those CLI defaults automatically. The conversation session excludes
arbitrary MCP, codemode and shell/edit tools.

Prompts describe general behavior: inspect the project, identify its language/environment/checks,
preserve scope and report verification gaps. Selecting an offered option authorizes that work;
do not ask for another confirmation. Avoid wording tuned to the acceptance script's phrases.

The [setup article](https://brucehopkins.dev/blog/how-to-set-up-pi-coding-agent-like-claude-code)
informs these workload judgments; they are not measured usage percentages:

- Add [pi-web-access](https://pi.dev/packages/pi-web-access) for documentation and supplied URLs.
- Use focused diagnostics rather than defaulting to [Pi Lens](https://pi.dev/packages/pi-lens), whose
  guards, autoformatting, scanning and native dependencies overlap Fade's own lifecycle.
- Use existing Pi MCP support rather than another adapter.
- Fade already supplies questions, planning and progress; duplicate packages add no useful interaction.
- Leave the subagent framework out of the default: concurrent writers and another orchestration
  system do not fit the bounded request/checkpoint loop. Existing MCP integrations remain configurable.

## Verification and gate

Source budget: about 3,800 lines. One added runtime package: pi-web-access, pinned to 0.41.0.
Tests cover loop transitions, proof failure/conflict paths, plan parsing, rendering and real diagnostics. Run:

```
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
npm run snapshot
```

Render empty, building and needs-you at wide widths and 80×24. Hints list at most four keys. No old jargon
or focus hints. Keep proof, retry and quiet-landing tests passing. `scripts/conversation-smoke.ts` exercises
real Pi sessions in an isolated CLI repository using `opencode-go/deepseek-v4-flash`.
`scripts/capabilities-smoke.ts` checks actual search/fetch and session tool boundaries without a
model call. `scripts/python-smoke.ts` checks a real Python repair through Pi agents, independently
rerun proofs and quiet landing in a temporary repository.

**Try it (human gate):** run `fade --demo`, then a real Pi session on a small repo: “add a --version flag” →
“On it” → ✓ describing the checked outcome → “undo that” → reverted. Then “make the help text friendlier” → a question →
“the second one” → built → “yes” to the look. A first-time user must complete this without opening help or
pressing anything except typing, Enter and Esc. Automated checks cannot pass this human gate.
