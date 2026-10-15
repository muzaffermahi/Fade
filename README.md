# Fade

**Just talk to it.**

Tell Fade what you want. Clear requests start building immediately, with an “On it” read-back.
While the Builder works in the side rail, keep thinking and talking to Fade about the next thing.
If Fade misunderstood, correct it in words. Git checkpoints make undo cheap.

## Quick start

```bash
npm ci
node --import tsx src/cli.ts --demo
# A real project:
node --import tsx src/cli.ts login
node --import tsx src/cli.ts --builder opencode-go/deepseek-v4-flash --companion opencode-go/deepseek-v4-flash
```

Needs Node 22.19+ and git. The demo uses a temporary repository and fake agents, with no model calls.
In under a minute: type “add a version file”, wait for ✓, then “make the help text friendlier”,
answer “the second one”, and say “yes” to the look question. “undo that” queues a revert.
Demo files illustrate the flow; use a real model to build your project.

## The loop

You talk to **Fade** in one conversation. While work builds or needs your answer, a side rail shows
Now, queued work and Needs you. Empty sections disappear; idle conversations use the full width.
At narrow widths, a compact status line replaces the active rail. `PLAN.md` remains editable by hand.

Clear, small asks queue work immediately. Fuzzy or large asks get one concrete question or a proposed
step and “Want it?”. Say “yes” to a proposal, “stop” to stop work, “undo that” to undo a checkpoint,
“show me the diff” to inspect work, or “no, I meant…” to correct it. Only your latest message can
ask Fade to queue, ready, accept, revise or undo.

Fade re-runs proof commands after checkpointing. Verified work lands quietly with an outcome, such as
“✓ Search works — typing gro finds Groceries (checked).” Commands and actual output stay in Show.
Failed checks get one automatic retry. Questions about how it looks get ◆ and your say.
Unfinished work and results Fade could not check stay visible in the conversation.
There are no visible goals or progress counters. After a minute of quiet, the empty idle composer
asks what you would like to do next; it does not start an AI reply.

## Keys

| Key | Action |
|---|---|
| Enter | Send |
| Esc | Stop Fade’s reply; close an open view |
| PgUp / PgDn | Scroll |
| Ctrl+C twice | First clears input and warns; a second within 1.5 seconds quits |

`?` on an empty line opens help. Slash commands: `/model`, `/login`, `/new`, `/show`, `/help`, `/quit`.
`/model` asks whose model to change; `/model builder provider/model` and `/model fade provider/model`
select directly. Skills and prompt templates still pass through to Pi. Use Pi in another terminal for
login, session trees and settings; `/login` explains how. Model choices persist in `.fade/config.json`.
Show is read-only: summary, checks with actual output, changed files and diff, scrolled together.

## Checking code and using the web

The Builder can run your project's commands, including Python, through its shell. `fade_check` adds
focused Python syntax checks and existing unittest/pytest tests, JavaScript syntax checks and local
TypeScript typechecking. It prefers `.venv`, then an available Python executable. Syntax success does
not prove runtime behavior; missing dependencies and empty test discovery are reported honestly.
No runtimes, test frameworks or language servers are installed automatically. Other languages use
the project's own tests and build commands through the shell.

Web search and page fetching are bundled through [pi-web-access](https://pi.dev/packages/pi-web-access).
The default search can use keyless Exa; provider settings remain in `~/.pi/agent/web-search.json`.
Availability depends on the provider and network. Both agents can research documentation; Fade's
conversation session retains read-only project access.

The Builder also loads Pi's native MCP discovery and codemode. Existing servers in
`~/.pi/agent/mcp.json` or a trusted project's `.pi/mcp.json` can be discovered when needed.
No additional MCP adapter is required. Manage server configuration and sign-in through Pi.

## PLAN.md

```markdown
# Plan
## [ready] Search
Search titles and body as you type.
Done when: typing "gro" shows "Groceries".

## Later
- Export to markdown
```

States remain draft, ready, building, review and done. The top ready card builds first.
Hand edits are watched live. Each build checkpoints on the current branch, including your concurrent
edits; use a throwaway repo to try the flow. Undo queues an intelligent revert through the Builder.
Later ideas stay in PLAN.md. Legacy Goal lines remain readable on disk but are hidden from the interface.

Development: `npm test`, `npm run check`, `npm run snapshot`. Built on the Pi agent toolkit.
Bring your own models, including local models. Builders need reliable tool calling. MIT licensed.
