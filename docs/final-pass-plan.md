# Fade final pass: ready to share

**Owner override:** retain Builder MCP, codemode and tool_search. Complete available work;
record macOS and human-study gates as pending. Publishing still requires approval.

**Goal:** a stranger installs Fade, tries it on their own project, and within five minutes thinks:
*"It checks its own work, and it only asks me about taste."*

This is a polish-and-subtract pass, not a feature release. Work phase by phase. Each phase ends with a
**Try it** check. Don't start the next phase until it passes. Rules from `AGENTS.md` still apply.

The pitch everything serves:
1. **Just talk to it.** One conversation, no modes, no hotkeys to learn.
2. **You never wait.** Keep talking while it builds.
3. **"Checked" means Fade ran it.** Not the model's word: Fade re-runs the proof on the commit.
4. **It only asks you about taste.** Everything else it settles itself or lands quietly.

---

## Phase 0: Lock in what exists (15 min)

- The current v0.4 work is about 40 uncommitted files on `codex/claude-review`. Commit it as-is
  (`Fade v0.4: just talk to it`) so every later change is a small, reviewable diff.
- Fix the duplicated `if (!model) throw …` line in `src/agents/pi.ts`.
- **Try it:** `git status` is clean, and tests, typecheck and build all pass.

## Phase 1: Feel (the Jobs pass)

Everything on screen should be calm, steady and human.

1. **The layout never jumps.** Today the conversation re-wraps from full width to half width (with
   different spacing) whenever the rail appears or disappears. Pick one rule:
   - The conversation column keeps a **fixed max width** (about 88 columns), the same in every state.
   - The rail lives in the space to its right when the terminal is wide enough. It never resizes the
     conversation.
   - Messages use **the same spacing everywhere**: one blank line between speakers, none inside a message.
   - At narrow widths, use the status line only (as today).
   - Add a render test: the same transcript renders the same conversation lines with and without
     active work.
2. **Every action gets a reply in the conversation.** A toast is not a reply. Fade's code writes
   these lines (no model call) for every fast path and every work tool:
   - "yes" to a look → `✓ Friendlier help — done.`
   - "yes" to a proposal → `On it: <title>.`
   - "undo that" → `↩ Undoing Friendlier help…`, then `↩ Friendlier help is undone.`
   - "stop" → `■ Stopped Search. Say "continue" or tell me what to change.`
   - Keep the toast only for things that aren't part of the conversation (Ctrl+C warning, /model).
3. **The ✓ is the hero.** It's the one thing no other tool has. Render "checked" verified outcomes with
   a mint `✓` and the outcome in normal text. End with a faint `checked` badge, not "(checked)" in
   parentheses. Claims Fade couldn't run get a hollow `○` and "not checked: <why>". Same wording
   everywhere: conversation, rail, Show.
4. **Human wording.** Go through every string the user can see: landing messages, splash, help,
   errors, empty state and placeholders. Rewrite anything that reads like a log line:
   - Undo cards land as `↩ <title> is undone.`, never "Undo: X — that change is gone and the project
     still builds…".
   - Titles start with a capital letter and are at most 5 words. Normalize them in `PlanModel.add`
     ("add a dark mode toggle" → "Dark mode toggle"). The fake agents use the same rule, so the demo
     looks right.
   - No internal words on screen: card, draft, ready, review, verdict, proof, Builder question.
5. **Deterministic read-back.** Don't rely on the model to say "On it". When `fade_queue` succeeds,
   Fade writes `On it: <title>.` itself. If the model also wrote a read-back in the same reply,
   suppress the duplicate. This makes weak models look as good as strong ones on the most visible line.
6. **The empty screen sells the product.** First launch in a project shows three example lines the
   user can just type, dimmed, not as a menu:
   `add a --version flag` · `why is the login slow?` · `make the settings page calmer`
   These disappear after the first message.

**Try it:** run `fade --demo` and do the README's one-minute flow. Nothing jumps, every message you send
gets an answer in the conversation, and no internal word appears on screen.

## Phase 2: Subtract

1. **Remove MCP discovery, codemode and tool_search from the Builder** (`src/agents/pi.ts` `loader`,
   `src/agents/builder.ts` tool list, the prompt lines and the README section). They're used far less than
   20% of the time, they lengthen the prompt, and they widen what the Builder can touch.
   **Keep web search and fetch** (pi-web-access) and **keep `fade_check`**, but cap it at its current
   scope: no new languages in this pass.
2. **Shorter prompts.** Rewrite `COMPANION_PROMPT` and `BUILDER_PROMPT` to about half their length.
   Anything code now guarantees (read-back, landing text, no state words, Windows shell notes that
   `cardMessage` already adds) leaves the prompt. Keep the rules only the model can follow: scope,
   when to ask, permission only from the latest human message, proof vs. look, and honesty about failures.
   No mention of internal implementation details (such as `workflow: none`) unless a tool needs them.
3. **Readable code.** Remove every line over 120 characters (48 today) and every compound one-liner
   added to fit the budget. **Raise the AGENTS.md budget to ~4,000 lines** instead of compressing code.
   Readable beats short. MCP removal should pay for most of it.
4. **Dead code sweep:** legacy goal plumbing that's still in state or view but never shown, unused
   `PlanApi` methods, `landedReviews` if Show can use `git show` alone, and stale scripts in `scripts/`
   (keep `snapshot`, `headless`, one live smoke script).
5. **Stale docs:** fold `docs/v0.3-slice-a-live-test.md` and `docs/v0.4-validation.md` into one short
   `docs/changelog.md` entry. Update `docs/rebuild-plan.md` so it describes what Fade is now, in under 150 lines.

**Try it:** the tests pass, source is ≤ 4,000 lines with no line over 120 characters, and a real session
still searches the web and fixes a Python bug.

## Phase 3: Safe in a stranger's repo

People will point this at real projects. The first bad surprise ends the trial.

1. **Uncommitted changes on launch:** if the working tree is dirty, Fade's first message says:
   `Heads up: you have uncommitted changes. My first checkpoint will include them.` Then it carries on.
   There's no prompt and no new mode.
2. **Checkpoint commits on the current branch** stay as they are, but the first launch in a repo says
   so once: `I'll commit each change on main as "fade: …", so anything can be undone.` Store the
   "said once" flag in `.fade/state.json`.
3. **Every failure is a sentence with a next step.** Check and fix each of these:
   - no git
   - no login
   - unknown model
   - a model without tool calling (the detector exists; check its wording)
   - network down during web search
   - a proof that times out
   - a commit failing because of a hook
   - quitting mid-build and relaunching (the card resumes or is clearly paused)
4. **Cross-platform smoke:** Windows Terminal (owner), macOS Terminal or iTerm, and one Linux terminal
   (WSL is fine). Check the proof shell on each: cmd.exe on Windows, sh elsewhere.

**Try it:** run Fade on a dirty clone of a real open-source repo, quit mid-build, relaunch, finish, and undo.
Nothing surprises you, and every message tells you what to do.

## Phase 4: First five minutes

1. **One-command install.** Verify the npm package builds and runs from a clean folder:
   `npm pack` → `npx ./fade-*.tgz --demo`. Then publish (owner's go-ahead required) so
   `npx @muzaffermahi/fade --demo` works. Bump the version to 0.5.0.
2. **Model guidance.** Don't make strangers guess. `fade login` ends by suggesting one strong pair and
   one budget pair, chosen from real testing. Flash-class models follow the conversation rules
   inconsistently, so recommend a stronger model for the Fade voice even when the Builder runs cheap.
   Put the same two lines in the README.
3. **The demo tells the story in 30 seconds.** `--demo` opens with the example lines. The fake agents
   produce the exact pitch: one clear request lands `✓ … checked` quietly, one taste question,
   "yes", "undo that". Re-record `docs/demo.tape`, which still types Enter-on-empty and "a" from the
   old keys, into `docs/assets/demo.gif`.
4. **README in one screen:** one sentence, the GIF, three install lines, the four promises from the top
   of this plan, "say yes / undo that / show me / stop", and keys (Enter, Esc, Ctrl+C twice). Move
   PLAN.md details, `fade_check`, web search and model flags to a short "More" section below. Note
   that web search sends queries to the configured search provider.
5. **Launch posts:** update `docs/launch/posts.md` to the new pitch. Lead with "checked means Fade ran it".

**Try it:** on a clean machine or a fresh user account, go from the README to a first `✓ checked` result on a
real project in under five minutes, without reading past the first screen.

## Phase 5: Hallway test (the real gate)

Five people who haven't seen Fade. Each brings a small real project.

- **Script:** "Install it from the README and get it to do something useful in your project. I won't help."
  Then watch silently for 15 minutes, or record the screen.
- **Write down:** every hesitation longer than about 5 seconds, every "what does this mean?", every key
  they try that does nothing, every time they doubt something was really done, and whether they would
  use it again tomorrow.
- **Fix the top 5 problems**, then repeat with two new people.
- **Pass (all must hold):**
  1. 4 of 5 reach a useful `✓ checked` result without help.
  2. Nobody needs the help screen to get started.
  3. Nobody reports a "checked" result that turned out wrong.
  4. Nobody loses work (Ctrl+C, undo, a dirty tree).
  5. 3 of 5 say they'd use it again.

## Not in this pass

New languages for `fade_check`, MCP, subagents, screenshots or visual checks, a `fade/` working branch,
browsers, voice, cloud sync, accounts, plugins, metrics dashboards. Anything the hallway test doesn't
ask for waits.

## Verification commands (from `Fade/`)

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
node --import tsx scripts/snapshot.ts
node node_modules/typescript/bin/tsc -p tsconfig.json
git diff --check
```

The phase "Try it" checks are the real gates. Report each one with what you saw, not just command
output. Don't commit, push or publish unless the human asks. Phase 0 and the publish step in
Phase 4 need explicit approval.
