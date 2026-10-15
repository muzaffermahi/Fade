<p align="center">
  <img src="docs/assets/fade-logo.webp" alt="Fade" width="420">
</p>

<p align="center"><b>Stop waiting on your AI. Keep talking while it builds.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@muzaffermahi/fade"><img alt="npm" src="https://img.shields.io/npm/v/@muzaffermahi/fade?style=flat-square&color=7ee0b5"></a>
  <img alt="Node 22.19+" src="https://img.shields.io/badge/node-22.19%2B-7ee0b5?style=flat-square">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-b9a6ff?style=flat-square"></a>
</p>

**Fade is a coding agent for your terminal that lets two of you work at the same time.** You talk with
Fade. Next to you, a separate **Builder** writes the code. You never sit and watch a spinner. While the
Builder works on one thing, you keep talking: plan the next feature, ask how something works, change your
mind, or line up three more tasks. When work lands, Fade has already **run the checks itself**. It only
interrupts you for the things a test can't decide: taste, wording, how something should feel.

![Fade demo: one request lands checked while the conversation keeps going](docs/assets/demo.gif)

```sh
npx @muzaffermahi/fade --demo     # try it in 30 seconds: no key, no install, fake agents
```

---

## Why Fade

Most coding agents work like a vending machine: you type a prompt, wait several minutes, read a long
report, and type again. The waiting breaks your focus. The report asks you to trust that "tests pass."
Fade is built on three bets:

<table>
<tr><td><b>You never wait</b></td><td>Fade (the voice you talk to) and the Builder (the one that edits code) run side by side. While a change builds, the conversation stays open. Plan ahead, ask questions, or steer the work in progress. Anything you agree on lines up under <b>UP NEXT</b>, and the Builder takes it as soon as it's free.</td></tr>
<tr><td><b>"Checked" means Fade ran it</b></td><td>The Builder writes a proof for each result, such as a focused test or a command. After it finishes, Fade saves the change as a Git commit and <b>re-runs those proofs itself</b> against that commit. A model saying "tests pass" is not a check. If a proof fails, the work goes back to the Builder once, automatically, with the real output.</td></tr>
<tr><td><b>It only asks you about taste</b></td><td>Work that passes its checks lands on its own: <code>✓ Search works — typing "gro" finds Groceries · checked</code>. Things only a person can judge wait under <b>NEEDS YOU</b> as one plain question: <i>"Does the help text feel friendlier?"</i> You answer in words.</td></tr>
</table>

And there's nothing to memorize. There are no modes, panels to switch between, or action hotkeys. You
type sentences. *"yes"*, *"undo that"*, *"show me the diff"* and *"stop"* all work.

## Quick start

Needs **Node 22.19+** and **Git**.

```sh
# 1. See the whole loop with fake agents (no key, no model calls, temporary folder)
npx @muzaffermahi/fade --demo

# 2. Connect a model provider (uses Pi's login: Anthropic, OpenAI, Google, OpenRouter, Ollama, …)
npx @muzaffermahi/fade login

# 3. Run it in your project
cd your-project
npx @muzaffermahi/fade
```

Or install it once: `npm i -g @muzaffermahi/fade`, then just run `fade`.

> The first `npx` run downloads about 200 MB of dependencies (mostly model-provider SDKs). Later runs start instantly.
>
> Fade commits each change to your current branch. **Try it on a throwaway project first.**

## How it works

```
 fade · notes-app · main
──────────────────────────────────────────────────────────┬──────────────────────────────
 you   add search to my notes                             │ BUILDER
 fade  On it: Search notes. The Builder is on it now;     │ ◌ Search notes  01:42
       keep talking to me while it builds.                │   ✓ Read the note store
 you   while that runs: what would tags look like?        │   ◌ Wire up the search box
 fade  A tag field on each note, filter by clicking one.  │     └ editing src/search.ts
       Want it next?                                      │
 you   yes                                                │ UP NEXT
 fade  On it: Note tags.                                  │ ○ Note tags
 fade  ✓ Search notes — typing "gro" finds Groceries ·    │
       checked                                            │ NEEDS YOU
                                                          │   Nothing. Checked work lands
                                                          │   on its own.
──────────────────────────────────────────────────────────┴──────────────────────────────
  › keep talking: plan the next thing, ask, or steer while it builds…
```

**Left: the conversation.** This is the only place you type. Fade reads your project, answers questions,
asks one concrete question when a request is genuinely ambiguous, and hands clear work to the Builder.

**Right: the sidebar, always open.**
- **BUILDER** — what's being built right now, its steps, and the file it's touching.
- **UP NEXT** — work you've lined up. The Builder takes the top item as soon as it finishes.
- **NEEDS YOU** — the only things waiting on you: a taste question, or a result Fade couldn't check.

On narrow terminals, the sidebar folds into one status line above the input.

### The loop

1. **You ask.** A clear request starts right away. Fade replies with a one-line read-back (*"On it:
   Search notes."*) so you can see what it understood. If it got it wrong, just say so; the Builder stops
   and restarts from the last commit.
2. **You keep going.** While the Builder works, talk about anything: the next feature, a bug you
   noticed, a question about the code. Agreed work queues up under UP NEXT. Tangents can be parked for later.
3. **The Builder finishes and Fade checks.** Fade commits the change (`fade: Search notes`) and
   re-runs every proof the Builder wrote, on that exact commit.
4. **It lands, or it asks.**

   | You see | Meaning |
   |---|---|
   | `✓ Search notes — typing "gro" finds Groceries · checked` | Fade ran the proof and it passed. Done; nothing to do. |
   | `◆ Settings is built. Your call: Does it feel calmer?` | Only you can judge this. Answer "yes" or say what to change. |
   | `○ Export — not checked: needs a real browser` | The Builder said it works, but there was no way to run a proof. Look yourself ("show me"). |
   | `✗ Export didn't pass its checks.` | A proof failed. Fade already sent it back once with the real output; this is the second failure. |

5. **Change your mind anytime.** *"undo that"* reverts the last change with a new commit, even if later
   work touched the same files. Nothing is ever force-deleted.

## What you can say

| You say | Fade does |
|---|---|
| *"add a --version flag"* | Starts building it immediately |
| *"make the settings page calmer"* | Asks one question with concrete options first |
| *"the second one"* | Picks that option and starts building |
| *"yes"* | Accepts the waiting result, or starts the proposed step |
| *"no, I meant only the spacing"* | Rewrites the task and restarts from before the wrong attempt |
| *"also make it blue"* (while building) | Passes the note to the Builder mid-task |
| *"show me"* / *"show me the diff"* | Opens the result: summary, checks with real output, changed files, diff |
| *"undo that"* | Reverts the last change |
| *"stop"* | Stops the Builder; its partial work is saved |
| *"continue"* | Resumes paused work |
| *"do tags first"* | Reorders what's up next |
| *"why is the login slow?"* | Just answers. Not everything has to become a task. |

**Keys:** `Enter` sends · `Esc` stops Fade's reply or closes a view · `PgUp`/`PgDn` scroll · `Ctrl+C`
twice quits · `?` on an empty line opens help.
**Commands:** `/model` · `/login` · `/new` · `/show` · `/help` · `/quit`.

## Models

Fade runs two model sessions: **the voice** (Fade, which talks and plans) and **the Builder** (which edits
code). They can be different models. A capable voice matters most for understanding you; the Builder needs
reliable tool calling.

```sh
fade --companion <provider/model> --builder <provider/model>
```

Pairs we've tested end to end:

```sh
# Strong: Kimi for both
fade --companion opencode-go/kimi-k3 --builder opencode-go/kimi-k3
# Budget: Kimi for the voice, DeepSeek Flash for the Builder
fade --companion opencode-go/kimi-k3 --builder opencode-go/deepseek-v4-flash
```

Any provider Pi supports works, including Anthropic, OpenAI, Google, OpenRouter and local models through
Ollama. Flash-class models make a fine Builder but an unreliable voice. `/model` switches either one and
remembers the choice for the project. If a model answers in prose without using its tools, Fade tells you
and suggests using it as the voice instead.

## What the Builder can do

- **Edit and run your project** with a shell, like any coding agent: your tests, your build, your scripts.
- **Check its own work** with `fade_check`: Python syntax and unittest/pytest (it finds your `.venv`),
  JavaScript syntax, and TypeScript typechecking. It reports honestly when only syntax was checked, when no
  tests were found, or when a runtime is missing.
- **Search the web and read pages** (via [pi-web-access](https://pi.dev/packages/pi-web-access)) for
  current docs and unfamiliar APIs. The voice can search too. Search queries go to your configured
  search provider.
- **Use your MCP servers** through Pi's native MCP support, codemode and tool search. Configure servers in
  `~/.pi/agent/mcp.json` or a trusted project's `.pi/mcp.json`.

The voice can read your project and search the web, but it can't edit files or run commands. Only the
Builder changes code, and every change becomes a commit.

## Git, safety and undo

- **Every change is a commit** on your current branch, named `fade: <what changed>`. Fade tells you
  this the first time it runs in a project.
- **Uncommitted changes:** if your working tree is dirty at launch, Fade says so. Your edits are
  included in its first commit.
- **Undo is a sentence.** *"undo that"* asks the Builder to revert the change cleanly, keeping later work.
- **Quitting mid-build is safe.** Partial work is saved and paused. Say *"continue"* when you're back.
- **Proofs are bounded.** They're finite commands with a timeout, run on the saved commit. No servers,
  no watchers.

## The plan file

Everything lined up lives in `PLAN.md` at your project root: plain Markdown that you can read, edit or
reorder by hand while Fade runs. Ideas you park for later sit under `## Later`.

```markdown
# Plan

## [ready] Note tags
A tag field on each note; clicking a tag filters the list.
Done when: clicking "work" shows only notes tagged work.

## Later
- Export to markdown
```

You never need to touch it. It's there so the plan is yours, visible and versionable.

## FAQ

**How is this different from Claude Code, Codex or OpenCode?**
Those are excellent single-agent loops: you prompt, the agent works, you review. Fade splits the work
into two parallel roles so you're never blocked while the agent works. It also treats verification as
Fade's job, not the model's: "checked" means Fade itself re-ran the proof on the saved commit.

**Does it work with local models?**
Yes, through Pi's providers (including Ollama). Use your strongest model as the Builder; tool calling
quality matters most there.

**Does it run on Windows?**
Yes. It's developed on Windows Terminal and tested on Linux. macOS uses the same code path.

**What does it cost?**
Fade is free and MIT licensed. You pay your model provider as usual. Two sessions run, but the voice
is cheap: it mostly talks and reads.

**Can I use it on my main branch?**
You can, and undo works. But start with a throwaway project until you trust it.

## Development

```sh
npm ci
npm test            # unit, loop and render tests
npm run check       # typecheck
npm run snapshot    # headless renders of the main screens
npm run demo        # the demo from source
```

Built on [Pi](https://github.com/earendil-works/pi), a minimal, extensible agent toolkit: Fade uses its
model runtime, sessions, tools and terminal UI. MIT licensed.
