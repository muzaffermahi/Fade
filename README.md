# Fade

**Get your flow back. You navigate, AI drives.**

<!-- Record with VHS from `fade --demo` (docs/demo.tape) and save as docs/assets/demo.gif -->
![Fade demo](docs/assets/demo.gif)

Waiting on an AI agent kills focus. Fade keeps you on **one thread**: the Builder builds the current step while you
shape the next one with the Companion, and the screen only ever shows you the **one next thing** worth doing.

- **One thread.** One goal at a time. Stray ideas get parked in *Later* (Ctrl+N), never lost, never chased.
- **One next thing.** A single NEXT line: a blocked Builder, the step you just discussed, the step that landed, or an
  idle Builder. Enter on an empty line acts on it. Nothing changes under you while you type.
- **Runway.** `runway ~12m` tells you how much think-time you have before the Builder runs out of ready steps.
- **Feedback first.** Fade re-runs proof commands against the checkpoint. Fully proved steps land quietly with `u` to
  undo; visual or taste checks ask for your yes/no. Unproved claims and failed checks stay visible in review.
  `t` runs the try command, `d` shows the diff.
- **Any model**, including local ones. Run the Companion on a local model and the Builder on your strongest.

## Quick start

```bash
npx @muzaffermahi/fade --demo     # try it: fake agents, no key, no install
npm i -g @muzaffermahi/fade       # then:
fade login                        # connect a provider
fade                              # run in any git project
```

Needs Node 22.19+ and git.

## The loop

Three things: **Builder** (left, builds the topmost *ready* step), **Companion** (right, thinks with you, reads the
project, writes steps; never changes code), **Plan** (`PLAN.md`, editable by hand).

```
·  draft     an idea being shaped      ◌  building  the Builder is on it
○  ready     you readied it            ◆  review    landed, waiting for you
✓  done      accepted; it fades out
```

Only you ready steps. Every finished step becomes a git commit, so undo is just another step.

## Keys

| Key | What it does |
|---|---|
| `⏎` on an empty line / `ctrl+r` | do the NEXT thing |
| `ctrl+n` | park a thought in Later |
| `tab` | focus Builder → Companion → Plan |
| `esc` | stop the Builder step / Companion reply |
| Plan: `space` `⏎` `n` `x` `alt+↑↓` | ready · open · new · drop · move |
| Review: `a` `r` `u` `t` `d` | accept · revise · undo · try · diff |
| `/` | commands: `/model` `/goal` `/later` `/recap` `/tree` `/login` and every Pi command |
| `?` | help |

`/model` in a pane switches that agent's model and remembers it. Pi's own screens (`/tree`, `/resume`, `/settings`)
open on that agent's session and return when you `/quit`.

## Local models

```bash
fade --companion ollama/<model> --builder anthropic/<model>
```

Builders need strong tool calling. If a model answers in prose without using tools, Fade says so and suggests using
it as the Companion instead.

## PLAN.md

```markdown
# Plan
Goal: Add search to the notes app

## [ready] Index note titles
Search by title as you type.
Done when: typing "gro" shows "Groceries".

## Later
- Export to markdown
```

Edit it while Fade runs; changes are picked up live.

## Why

Code is cheap now. Clarity isn't. When an agent codes faster than you can read, the bottleneck is knowing what you
want, and the cost is the wait. Fade is built around the human's attention, not the agent's output.

Development: `npm ci`, `npm test`, `npm run snapshot`, `npm run perf`. Built on the Pi agent toolkit: your Pi logins,
models, skills and extensions just work. MIT licensed.
