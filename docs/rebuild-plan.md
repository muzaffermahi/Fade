# Fade rebuild plan

Status: approved direction, 2026-10-14. Supersedes `product-contract.md`, `readiness-plan.md` and `work-orders/`, which stay on the `archive/contract-era` branch.

## North star

**Code is cheap now. Clarity isn't.**

AI writes code faster than any of us. The bottleneck has moved to *knowing what we want* and giving it structure. Today's tools ignore this: you prompt, then you wait ten minutes doing nothing, then you review, then you prompt again. That kills focus.

Fade gives you two collaborators at the same time:

- the **Builder** builds what's ready,
- the **Companion** helps you figure out what's next,

and you stay locked in the whole time, the way coding felt before AI: one clear thing in your head, quick feedback, steady momentum, and no babysitting.

## Design principles

These are rules, not aspirations. When an implementation choice is unclear, these decide it.

1. **Simple enough to explain in one breath.** There are three things (Builder, Companion, Plan) and cards move through five states. If a feature needs a new concept, it probably shouldn't exist.
2. **Never steal focus.** Nothing moves your cursor, opens a dialog, or switches panes on its own. Ever.
3. **Ambient, not alarming.** Builder progress sits in your peripheral vision, like a build running in the corner. Only three things ever ask for you: a card ready to review, a Builder question, or the Builder sitting idle. They always appear in the same place.
4. **There's always a next action.** At any moment the screen makes it obvious what you could do now.
5. **Keyboard only, two keys at most.** Every common action takes one or two keystrokes.
6. **Calm screen.** No token counts, costs, IDs, receipts, run limits or status jargon on the main screen.
7. **Visible momentum.** Finished work feels finished. Accepted cards literally *fade* out of the plan, and a quiet "shipped today: 4" counter tracks progress.
8. **Shaping is the craft.** Writing and sharpening cards with the Companion is the new "writing code". It should feel like focused writing, not like filling in forms.
9. **Trust the human; git is the undo.** No provenance tracking, authorization checks or receipt state machines. Every Builder card becomes a commit, so anything can be undone.
10. **Fast.** Usable within a second of launch. Typing never lags, even while both agents stream.

## The mental model

**Three things:**

| | Role | Can it change code? |
|---|---|---|
| **Builder** | Builds the top ready card. You can talk to it directly. | Yes |
| **Companion** | Thinks with you, reads the project, writes and edits cards. | No, read-only |
| **Plan** | `PLAN.md`: an ordered list of cards. The shared source of truth. | You edit it, and so does the Companion |

**Five card states:**

```
·  draft     an idea being shaped
○  ready     you pressed space: the Builder may take it
◌  building  the Builder is on it
◆  review    finished, waiting for you to look
✓  done      you accepted it; it fades out
```

**One rule for readiness:** only you mark a card ready (Space). The Companion can draft and edit cards but never make them ready. The Builder always takes the **topmost** ready card, so order means priority.

## The flow

### First launch in a project
- Fade checks for git and offers `git init` if there isn't a repository. Git is required, because review and undo depend on it.
- The startup screen shows the full dissolving wordmark, then settles into the workspace with the Companion focused: *"What are we making?"*
- If you'd rather jump straight in, Tab to the Builder and type a request. See "Quick cards" below.

### Shaping (Companion)
- You talk with the Companion about the idea. It reads the project, asks the questions that matter, and pushes back on fuzziness.
- When something is concrete, it adds a card. The card appears in the conversation as `+ Notebook styling (draft)` and in Up Next.
- You press Space on cards you're happy with. The Builder picks them up from the top.

### Building (Builder)
- The Builder posts a short step list (✓ / ◌ / ○) and keeps it updated, with the current action underneath (`└ editing src/search.ts`).
- You can type in the Builder pane at any time. While it's building, your message steers the current card.
- When the card is done, Fade makes a **checkpoint commit** (`fade: Search`), Fade runs its proofs, then sends it to review or quietly accepts fully verified work before starting the next ready card.
- If the Builder gets stuck, the card goes to review with its question attached, and the Builder moves on to the next ready card. A blocked card never stalls the pipeline.

### Reviewing (you)
- v0.3 Slice A: Fade re-runs each proof after checkpointing, before the next card starts. Every agreed line must
  have a successful proof on that checkpoint for quiet acceptance. Looks ask for a human yes/no; model claims
  without commands are "said, not run". Missing lines fail; a turn without `fade_done` is unfinished.
- Fully verified cards land quietly in Done with `u` to queue an undo. Failed proof claims get one automatic retry,
  then review with the actual command output. Proofs are sequential, at most two minutes each and five minutes total.
- Select the card in *To review* and press Enter to see the summary, how to try it, and the diff.
- `a` **accept**: the card fades to ✓ done.
- `r` **revise**: you write a note, and the card goes back to the top of Up Next as ready, with your note attached.
- `u` **undo**: creates a top-priority ready card, "Undo: Search", for the Builder. The Builder reverts it intelligently, even if later cards touched the same files.

### Quick cards
Typing to the Builder while it's **idle** turns your message into a ready card at the top, and it starts right away. Everything still lives in the Plan, so there's only one model to learn.

### Idle
If the Builder finishes and nothing is ready, the bottom strip shows: *"Builder is free. Mark a card ready (space) or tell it what to do."* That's the only nudge.

## Screen

### Wide (≥ 100 columns)

```
 FADE · notes-app · main                               builder · sonnet   companion · opus
──────────────────────────────────────────────────────────────────────────────────────────
 BUILDER  Search                       ◌ 03:12  │ COMPANION
                                                │
 ✓ Read the note store                          │ you        Could it feel more like a notebook?
 ✓ Added a search index                         │
 ◌ Wiring search into the sidebar               │ companion  Warm paper, roomy margins, quiet
 ○ Run the tests                                │            controls. Make it a card?
   └ editing src/sidebar.tsx                    │
                                                │ you        yes, keep it one column
                                                │
                                                │            + Notebook styling  (draft)
                                                │
 ╭ note to builder ───────────────────────────╮ │ ╭ think it through ──────────────────────╮
 │                                            │ │ │ › what about typography?▌              │
 ╰────────────────────────────────────────────╯ │ ╰────────────────────────────────────────╯
──────────────────────────────────────────────────────────────────────────────────────────
 TO REVIEW  ◆ Core notes app · 5 files · tests pass        ⏎ look  a accept  r revise  u undo
 UP NEXT    ○ Export to markdown   · Notebook styling   · Tags               shipped today 2
──────────────────────────────────────────────────────────────────────────────────────────
 tab focus · space ready · ? help
```

- The focused pane has a mint border; the others are dim. That's the only focus indicator needed.
- The Builder pane shows the step list and the current action, not a tool log. Pressing `l` on the Builder pane toggles the raw tool output for curious moments.
- The Companion pane is an ordinary conversation, rendered as Markdown.
- The bottom strip is always exactly two lines (To review / Up next) plus the hint line.

### Plan focus (Tab to it)
The bottom strip grows into the full plan list:

```
 PLAN                                       ↑↓ select  space ready  ⏎ open  alt+↑↓ move  x drop
 ◆ Core notes app        review    "npm start, add a note, reload: it's still there"
 ◌ Search                building
 ○ Export to markdown    ready
 · Notebook styling      draft
 · Tags                  draft
 ✓ Project setup         done
```

`⏎` on a draft or ready card opens it for editing, inline or in `$EDITOR`.

### Narrow (< 100 columns)
One pane at a time, with a tab row `Builder ◌ · Companion · Plan`, and the same two-line bottom strip compressed to one line each. Measure the exact breakpoint with render tests.

### Keys (the whole list)

| Key | Action |
|---|---|
| Tab / Shift+Tab | Cycle focus: Builder → Companion → Plan |
| Enter | Send (in a composer) / open (in the Plan) |
| Space | Toggle ready (in the Plan) |
| Alt+↑ / Alt+↓ | Reorder a card |
| a / r / u | Accept / revise / undo a review card |
| x | Drop a card (asks to confirm) |
| l | Toggle raw Builder output |
| Esc | Stop the focused agent's current turn |
| ? | Help overlay |
| Ctrl+C ×2 | Quit (state is always saved) |

No slash commands in v0.1. `/model` may come later.

## PLAN.md format

Readable and editable by hand. Fade watches the file and picks up your edits live.

```markdown
# Plan

## [building] Search
Search notes by title and body as you type.
Done when: typing "gro" shows "Groceries".

## [ready] Export to markdown
One .md file per note in ./export.

## [draft] Notebook styling
Warm paper, roomy margins, one column. Open: serif or mono?

## Done
- Core notes app (a1b2c3d)
- Project setup (9f8e7d6)
```

- The heading is `## [state] Title`, and the body is free text. "Done when:" is encouraged, not required.
- Order is priority. The title is the card's identity; if you rename a card by hand, Fade treats it as a new card.
- Review details (summary, how to try it, commit sha) live in `.fade/state.json`, so the plan stays clean.

## Under the hood

### Architecture
Own the screen with `pi-tui` (`TUI`, `ProcessTerminal`, `Editor`, `Markdown`) and run **two Pi SDK sessions** with `createAgentSession`. Don't embed or hijack Pi's InteractiveMode: that's where most of the old complexity came from.

- **Login:** you run `pi` once to log in. Fade reuses Pi's credentials from the shared agent directory. Models are chosen with `--builder` / `--companion` or `.fade/config.json`, falling back to Pi's default model.
- **Builder session:** stock Pi tools (read, write, edit, bash) plus three custom tools:
  - `steps(list)`: sets the visible checklist
  - `done(summary, howToTry)`: finishes the card
  - `stuck(question)`: sends the card to review with a question

  It's **one long-lived session** across cards, using Pi's compaction, so the Builder remembers the project. Each card arrives as a normal user message: the card text plus a short pointer to `PLAN.md`. If a turn ends without `done` or `stuck`, the card goes to review, with the Builder's last message as the summary.
- **Companion session:** read-only Pi tools (read, grep, find, ls) plus `add_card`, `edit_card` and `read_plan`. It can't mark cards ready, write files or run a shell. Before each turn it gets a short ambient context: the current card and its steps, the review queue, and the Plan.
- **Checkpoints:** when a card finishes, run `git add -A && git commit -m "fade: <title>"`. The diff for review is `git show <sha>`. Undo is delegated to the Builder as a card.

### Modules and size budget
The target for v0.1 is **about 2,000 lines of source**. If it grows past that, simplify instead of adding more.

| File | Job | ~Lines |
|---|---|---|
| `src/plan.ts` | Parse and write `PLAN.md`, watch the file | 150 |
| `src/loop.ts` | Card state machine: pick the next ready card, handle done/stuck, accept/revise/undo | 150 |
| `src/builder.ts` | Builder Pi session and custom tools; emits steps and activity events | 200 |
| `src/companion.ts` | Companion Pi session, read-only tools, card tools, ambient context | 150 |
| `src/git.ts` | Checkpoint commit, diff stat, show | 80 |
| `src/state.ts` | `.fade/state.json` (review metadata, shipped count) | 60 |
| `src/ui/*` | Layout, Builder pane, Companion pane, bottom strip, Plan view, help, theme and wordmark | 900 |
| `src/cli.ts` | Flags, startup checks, launch | 60 |

**Bring across from the old code:** `wordmark()` and the mint/lavender/ivory palette from `workspace-ui.ts`, the Pi session/model resolution bits from `pi.ts`, and the terminal text sanitizer from `terminal-text.ts` if it's still needed. Leave everything else behind.

### Tests
- Unit tests for `plan.ts` (parse/write round trip, hand edits) and `loop.ts` (state transitions with fake agents).
- Headless render snapshots at 120×40 and 80×24 for the main states: empty, building, review waiting, idle.
- Nothing else in v0.1. The real gate for each phase is its "Try it" check.

## What we're dropping

Receipts and their 8-state input lifecycle; word-for-word quote provenance; the authorization regex; execution leases; immutable briefs and redirect machinery; the 50-command catalog; plain/line mode; image attachment limits UI; bug-report export; state migrations; run limits; usage/cost display; release packaging and qualification. They solved problems the product didn't have yet, and they buried the one it did. All of it is preserved on `archive/contract-era`.

## Phases

Each phase ends with a **Try it** check: a real person doing a real thing. Don't start the next phase until it passes.

### Phase 0: Clean slate (≈ half a day)
- Commit the current uncommitted work to a new branch, `archive/contract-era`. (This needs the owner's go-ahead.)
- Start a `rebuild` branch. Remove the old `src/`, `tests/`, `docs/`, `work-orders/`, `scripts/` and release files from it, keeping `LICENSE` and the notices. Trim `package.json` to its real dependencies.
- Replace `AGENTS.md` with the short version below. Remove `IMPLEMENTATION_STATUS.md`.
- **Try it:** `git log` on `rebuild` is clean, and `AGENTS.md` fits on one screen.

### Phase 1: The loop, with an ugly UI
- `plan.ts`, `loop.ts`, `builder.ts`, `git.ts`, `state.ts`, and a plain single-column screen that streams Builder activity and lists the plan.
- **Try it:** hand-write three cards in `PLAN.md` and mark two ready. Run `fade` and walk away. Come back to two commits, two cards in review, and one draft untouched. Then accept one and revise the other, and watch it rebuild.

### Phase 2: The Fade screen
- The two-pane layout, step timeline, bottom strip, Plan focus, review actions, every key in the table, and the narrow layout.
- **Try it:** while a card builds, chat in the Companion pane, reorder the plan and review the previous card. Nothing steals focus, typing never lags, and accept/revise/undo all work.

### Phase 3: The Companion as co-author
- Card tools, ambient context, and the Companion prompt. **The Companion's personality is the soul of the product,** so budget real iteration: run real sessions, read the transcripts, adjust.
- **Try it:** go from a fuzzy idea ("a tiny habit tracker") to three good cards in under five minutes, with no form-filling feeling.

### Phase 4: Feel pass
- The startup wordmark, the fade-out animation for accepted cards, "shipped today", the idle nudge, the stuck flow, the help overlay, resizing, and Windows Terminal checks (the owner is on Windows).
- **Try it:** use Fade for a full hour on a real project and write down every moment of friction. Fix the top five.

### Phase 5: Ready to share
- First-run onboarding, model selection, one-command install, a README with a GIF, and a short manifesto.
- **Try it:** a friend installs it and ships a card without any help.

## AGENTS.md (replacement, use as-is)

```markdown
# Fade

Read docs/rebuild-plan.md first. It is the only spec.

- Build only the current phase. Stop at its "Try it" check and report how to try it.
- Every change must be something a user can see or feel. If you can't demo it, don't build it.
- Source budget for v0.1 is ~2,000 lines. Over budget means simplify, not expand.
- Write plain, readable TypeScript: normal line lengths, one statement per line, small functions.
- No new concepts, states, commands, config or safety machinery beyond the plan. Git is the undo.
- When a UX choice is unclear, pick the simpler one and say so in your report.
- Tests: plan parser, loop transitions, render snapshots. Nothing else unless asked.
- Don't commit, push or publish unless the human asks.
```

## Making it spread (Phase 5 and after)

- **The hook is one sentence and one GIF.** *"Stop waiting on your AI. Plan the next thing while it builds this one."* The 30-second demo: type a fuzzy idea, the Companion makes three cards, press Space twice, the Builder builds while you shape a fourth, then accept, and the card fades out.
- **The look is the brand.** The dissolving wordmark and the cards fading on accept make Fade instantly recognizable in screenshots.
- **Bring your own model.** Pi supports cloud and local providers, which makes Fade interesting to the local-model crowd as well as Claude/GPT users.
- **The manifesto.** A short post: *"The new bottleneck: code is cheap, clarity isn't."* That's the idea people share, with Fade as its proof.
- **Channels:** Show HN, X, r/LocalLLaMA and r/ChatGPTCoding, and the Pi community.
- **Name and SEO, to decide later:** "fade" is hard to search for, and the npm name `fade` is taken.

## Open questions and risks

- **Checkpoint commits land on your current branch.** They make review and undo simple. The recommended default is on, with an opt-out. An alternative would be a `fade/` working branch.
- **Your own edits during a build** get included in the next checkpoint commit. Acceptable for v0.1; revisit after Phase 4.
- **Unreviewed cards piling up:** start without a cap and see whether it's a problem in real use.
- **Losing Pi's native `/model` and `/login` dialogs:** use `pi` for login and flags/config for models. Add a small picker in Phase 5 if people need one.
- **Windows rendering:** check Windows Terminal from Phase 2 onward, not at the end.

## v0.3 Slice A try-it gate

Implemented first: proof execution, honest verdicts, one automatic retry, read-back for quick cards and quiet
landing with undo. Slices B/C and the remaining waiting rules are gated on this real-project check.

Run Fade on a small real repository and request "add a --version flag". Confirm the read-back, a proof run on the
checkpoint, quiet Done, and `u` queuing a revert for that sha. Then request a change with a deliberately failing
proof: one retry, then a failed review showing real output. Also inspect a visual look and an unfinished turn.
Check proof timeouts in Windows Terminal. Human real-Pi validation is pending; do not start Slice B until it passes.

Slice A automated verification: TypeScript (`node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json`)
passed; full suite (`node --import tsx --test tests/*.test.ts`) passed 93/93, followed by the new stop-during-proof
regression (`node --import tsx --test --test-name-pattern="stopping proof" tests/loop.test.ts`) passing 1/1.
Snapshots (`node --import tsx scripts/snapshot.ts`) passed and were inspected at 120x40 and 80x24.
The Windows process-tree timeout test passed. The real-Pi/Windows Terminal human gate remains pending.

The Slice A technical live check was subsequently exercised with real Pi sessions using
`opencode-go/deepseek-v4-flash`. See [live test results](v0.3-slice-a-live-test.md) for failures found, prompt fixes,
successful quiet landing and undo, real failed-proof handling, Windows PTY review smoke test, and the remaining
real-user study. The final automated suite passed 94/94 tests.
