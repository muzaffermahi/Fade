# Build Fade v0.1: implementation prompt

You are building **Fade v0.1** from scratch in this repository (the `Fade/` folder). Read this whole file before writing any code. It is the complete spec. `docs/rebuild-plan.md` explains the *why*; if the two disagree, **this file wins**.

The human wants one thing: **a terminal app that just works and looks beautiful.** No ceremony and no over-engineering. Build all five phases below in order without stopping for approval. The human will review afterwards.

---

## 0. What Fade is (read this twice)

Fade is a terminal app with two AI agents working at the same time:

- **Builder** (left pane): writes code. It works through cards from `PLAN.md` one at a time.
- **Companion** (right pane): a thinking partner. It talks with the human, reads the project, and writes cards into `PLAN.md`. It never changes code.
- **Plan** (`PLAN.md`): an ordered list of cards. It is the shared source of truth.

A card moves through five states:

```
·  draft     an idea being shaped
○  ready     the human pressed Space; the Builder may take it
◌  building  the Builder is working on it
◆  review    finished; waiting for the human to look
✓  done      the human accepted it; it fades out of the list
```

**The loop:** the Builder always takes the **topmost `ready` card**. When it finishes, Fade makes a git commit, the card goes to `review`, and the Builder immediately takes the next ready card. Meanwhile, the human chats with the Companion to shape upcoming cards, and reviews finished ones. **Only the human marks cards ready.**

**The feeling we want:** calm, focused, keyboard-only, "locked in". Nothing steals focus. Nothing nags. The screen always makes the next action obvious.

---

## 1. Hard rules

1. **Simple beats clever.** If you're adding a concept, state, option or abstraction that isn't in this file, don't.
2. **Readable code.** Normal line lengths (≤ 120), one statement per line, small functions, descriptive names. No single file over 400 lines. Target about 2,500 lines of `src/` in total.
3. **Strict TypeScript** (the existing `tsconfig.json` is strict and has `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`). Don't use `any`. Avoid casts unless you're bridging an untyped library value, and add a comment when you do.
4. **Never write to stdout or stderr while the TUI is running.** `console.log` corrupts the screen. Show errors in the UI instead.
5. **Errors are always visible and human.** One short sentence in the relevant pane, such as *"Builder couldn't start: no model configured. Run `fade login`."* Never crash the TUI on an agent error.
6. **Don't** add: receipts, provenance tracking, authorization checks, permission gates, migrations, telemetry, a plugin system, a plain/line mode, image attachments, or slash commands. Git is the undo button.
7. **Keep the Pi dependencies pinned at `1.0.4`.** Don't upgrade or add dependencies beyond what's listed in section 3.
8. **Git:** the Phase 0 commands below, one commit per phase on `rebuild`, plus the checkpoint commits Fade itself makes at runtime. **Never push to `main` or force-push.** The repository is public.
9. **Windows first.** The human uses Windows (Git Bash and Windows Terminal). The npm script shims are unreliable there, so run Node entry points directly (see section 9).
10. If something in this spec turns out to be impossible with the real API, use the simplest working alternative, leave a `// NOTE:` comment, and mention it in your final report. Don't stall.

---

## 2. Phase 0: clean slate (do this first, exactly)

```bash
cd Fade                              # skip if you're already at the repo root
git status --short                  # should be clean: the old work is already committed on main
git branch archive/contract-era     # bookmark the old version (no new commit needed)
git checkout -b rebuild
git rm -r -q src tests scripts work-orders examples .github
git rm -q IMPLEMENTATION_STATUS.md CHANGELOG.md CONTRIBUTING.md SECURITY.md "Start Fade.cmd" \
  docs/install.md docs/product-contract.md docs/qualification.md docs/readiness-baseline.md \
  docs/readiness-gaps.md docs/readiness-plan.md docs/release-checklist.md docs/troubleshooting.md \
  docs/windows-access.md
```

**Keep** `LICENSE`, `THIRD_PARTY_NOTICES.md`, `docs/rebuild-plan.md`, `docs/BUILD_PROMPT.md`, `docs/assets/fade-logo.webp`, `tsconfig*.json`, `.gitignore` and `node_modules/`. **Don't touch** `releases/` or `output/`; they're ignored.

Then:
- Replace `AGENTS.md` with the short version in `docs/rebuild-plan.md` (section "AGENTS.md (replacement, use as-is)").
- Rewrite `package.json` as shown in section 3.
- Delete the old README content. You'll write the new one in Phase 5; for now a one-line placeholder is fine.

Commit at the end of each phase on the `rebuild` branch, with a message like `Fade v0.1 phase 2: the Fade screen`, so progress is never lost. **Never push to `main`.** Pushing the `rebuild` branch is fine if your environment requires it to save work.

---

## 3. Stack

- Node ≥ 22.19, ESM, TypeScript, `tsx` for running tests and scripts.
- `@earendil-works/pi-coding-agent` 1.0.4: agent sessions, tools, model and credential runtime.
- `@earendil-works/pi-tui` 1.0.4: the terminal UI (`TuiMainScreen`, `ProcessTerminal`, `Editor`, `Markdown`, key helpers).
- `typebox`: schemas for tool parameters.
- `node:test` for tests.

`package.json`:

```json
{
  "name": "@muzaffermahi/fade",
  "version": "0.1.0",
  "description": "Plan the next thing while AI builds this one.",
  "type": "module",
  "bin": { "fade": "dist/cli.js" },
  "engines": { "node": ">=22.19" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsx src/cli.ts",
    "demo": "tsx src/cli.ts --demo",
    "test": "node --import tsx --test tests/*.test.ts",
    "check": "tsc --noEmit -p tsconfig.test.json",
    "snapshot": "tsx scripts/snapshot.ts"
  },
  "dependencies": {
    "@earendil-works/pi-agent-core": "1.0.4",
    "@earendil-works/pi-ai": "1.0.4",
    "@earendil-works/pi-coding-agent": "1.0.4",
    "@earendil-works/pi-tui": "1.0.4",
    "@earendil-works/pi-codemode": "1.0.4",
    "@earendil-works/pi-mcp": "1.0.4",
    "@earendil-works/chord": "1.0.4",
    "typebox": "1.3.27"
  },
  "devDependencies": { "@types/node": "^24.0.0", "tsx": "^4.20.0", "typescript": "^5.9.0" },
  "files": ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"],
  "license": "MIT"
}
```

`node_modules` is already installed. Don't run `npm install` unless an import actually fails.

---

## 4. File layout

```
src/
  cli.ts            entry: flags, startup checks, launch TUI or demo
  types.ts          shared types (Card, CardState, Step, events, outcomes)
  plan.ts           PLAN.md parse/serialize + PlanStore (load, save, watch)
  state.ts          .fade/state.json (reviews, shipped count, companion transcript)
  git.ts            git helpers (isRepo, init, checkpoint, show, exclude .fade)
  loop.ts           Fade orchestrator: the card state machine + view model
  agents/
    pi.ts           shared Pi setup (model resolution, resource loader)
    builder.ts      PiBuilder implements BuilderAgent
    companion.ts    PiCompanion implements CompanionAgent
    prompts.ts      BUILDER_PROMPT, COMPANION_PROMPT, context formatting
    fake.ts         FakeBuilder + FakeCompanion (demo mode and tests)
  ui/
    theme.ts        palette, color helpers, glyphs, sanitize()
    logo.ts         big wordmark + compact mark
    app.ts          root component: layout, focus, keys, overlays
    builder-pane.ts
    companion-pane.ts
    strip.ts        bottom "To review / Up next" strip + expanded Plan list
    overlays.ts     help, review detail, card editor, text prompt, confirm
    splash.ts       startup splash with the big logo
tests/
  plan.test.ts  loop.test.ts  render.test.ts
scripts/
  snapshot.ts       headless renders of key states (use this to SEE your UI)
  live-smoke.ts     optional real-model run of one tiny card
```

---

## 5. Core types (`src/types.ts`)

```ts
export type CardState = 'draft' | 'ready' | 'building' | 'review';
export interface Card { title: string; state: CardState; body: string }
export interface DoneEntry { title: string; sha?: string }
export interface Plan { preamble: string; cards: Card[]; done: DoneEntry[] }

export interface Step { text: string; status: 'done' | 'active' | 'todo' }

export type BuildOutcome =
  | { kind: 'done'; summary: string; howToTry: string }
  | { kind: 'stuck'; question: string }
  | { kind: 'stopped' }
  | { kind: 'failed'; error: string };

export type BuilderEvent =
  | { type: 'steps'; steps: Step[] }
  | { type: 'action'; text: string }      // e.g. "editing src/search.ts"
  | { type: 'text'; text: string }        // full text of the assistant message being streamed
  | { type: 'message'; text: string }     // a finished assistant message
  | { type: 'log'; line: string };        // raw tool line for the Ctrl+L view

export type CompanionEvent =
  | { type: 'text'; text: string }        // full streamed text of the current reply
  | { type: 'message'; text: string }     // final reply
  | { type: 'card'; title: string; action: 'added' | 'edited' }
  | { type: 'tool'; text: string }        // e.g. "reading src/app.ts"
  | { type: 'error'; text: string };

export interface BuilderAgent {
  readonly busy: boolean;
  init(): Promise<void>;                  // create the Pi session; throws a human-readable error on failure
  build(card: Card, context: string, onEvent: (e: BuilderEvent) => void): Promise<BuildOutcome>;
  note(text: string): Promise<void>;      // steer the current build
  stop(): Promise<void>;
  dispose(): void;
}

export interface PlanApi {
  list(): Card[];
  addCard(title: string, body: string): string;                       // returns the final unique title
  editCard(title: string, patch: { title?: string; body?: string }): void;
}

export interface CompanionAgent {
  readonly busy: boolean;
  init(): Promise<void>;
  send(text: string, context: string, onEvent: (e: CompanionEvent) => void): Promise<void>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface Review {
  title: string;
  summary: string;
  howToTry: string;
  question?: string;          // set when the Builder got stuck
  sha?: string;               // checkpoint commit, if one was made
  files: string[];            // changed files in that commit
  finishedAt: number;
}
```

`done` isn't a `CardState`. Done cards live in `plan.done`.

---

## 6. PLAN.md (`src/plan.ts`)

The format is human-editable:

```markdown
# Plan

## [building] Search
Search notes by title and body as you type.
Done when: typing "gro" shows "Groceries".

## [ready] Export to markdown
One .md file per note in ./export.

## [draft] Notebook styling
Warm paper, roomy margins, one column.

## Done
- Core notes app (a1b2c3d)
- Project setup
```

**Parsing rules:**
- Text before the first `## ` heading is the `preamble`. Preserve it; default it to `# Plan\n`.
- `## Done` (case-insensitive) starts the done section. Each `- Title` or `- Title (sha)` line becomes a `DoneEntry`.
- Any other `## ` heading starts a card. `## [state] Title` sets the state. A missing or unknown state, or `[done]`, means `draft` (except that `[done]` cards move to the done list).
- The body is everything up to the next `## ` heading, trimmed.
- Duplicate titles: the second one becomes `Title 2`, then `Title 3`, and so on.

**Serializing:** preamble, then one `## [state] Title\n` + body + a blank line per card, then `## Done` with its entries (omit the section if it's empty). Always end with `\n`.

**PlanStore:**
- `load()` reads `PLAN.md` in the workspace. If the file is missing, use an empty plan; don't create the file until the first write.
- `save(plan)` writes atomically: write `PLAN.md.tmp`, then rename it over the original. Remember the exact written content.
- `watch(onExternalChange)` uses `fs.watch` with a 150 ms debounce. Ignore events whose file content equals the last written content.
- It must be pure enough to unit-test: export `parsePlan(text): Plan` and `serializePlan(plan): string`.

---

## 7. State (`src/state.ts`) and git (`src/git.ts`)

**`.fade/state.json`** holds `{ reviews: Review[], shipped: { date: 'YYYY-MM-DD', count: number }, companion: TranscriptEntry[] }`, where `TranscriptEntry = { role: 'you' | 'companion' | 'card' | 'tool' | 'error'; text: string }`. Keep the last 200 transcript entries. Writes are atomic, and the file is created lazily. On a new local date, `shipped.count` resets to 0.

**git.ts** runs `execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })`:
- `isRepo()`: `git rev-parse --is-inside-work-tree`.
- `init()`: `git init`.
- `excludeFade()`: makes sure `.fade/` is listed in `.git/info/exclude`. Use this, not `.gitignore`, so the user's files aren't modified.
- `hasChanges()`: `git status --porcelain` is non-empty.
- `checkpoint(message)`: `git add -A`, then `git commit -m message`. Returns `{ sha, files }` from `git rev-parse --short HEAD` and `git show --name-only --format= HEAD`. If the commit fails (for example, no `user.name` configured), return `{ error }` with the first line of stderr. Fade shows it, and the changes stay uncommitted.
- `show(sha)`: `git show --stat --patch --color=always <sha>`, used for the review overlay.

---

## 8. The loop (`src/loop.ts`)

`class Fade` owns everything: the plan, state, git and both agents. The UI only calls its methods and reads `fade.view()`.

```ts
constructor(opts: { cwd: string; plans: PlanStore; state: StateStore; git: Git;
                    builder: BuilderAgent; companion: CompanionAgent })
onChange(fn: () => void): () => void      // UI re-renders on every change
view(): FadeView                          // plain snapshot object, see below
start(): void                             // recovery, then tick()

// human actions
toggleReady(title)  move(title, -1 | 1)  drop(title)
addCard(title, body)  editCard(title, patch)
accept(title)  revise(title, note)  undo(title)
sendToBuilder(text)  sendToCompanion(text)
stopBuilder()  stopCompanion()
```

`FadeView` contains: `cards`, `done`, `reviews`, `building` (`{ title, steps, action, startedAt, liveText, lastMessage, notes: string[] } | null`), `builderLog: string[]` (last 200 lines), `builderError?: string`, `companion: TranscriptEntry[]`, `companionLive?: string`, `companionBusy`, `shippedToday`, `toast?: string` (a short transient message, cleared after 3 s).

**Transitions (implement exactly this table):**

| Trigger | From | To | Side effects |
|---|---|---|---|
| `toggleReady` | draft | ready | save plan, `tick()` |
| `toggleReady` | ready | draft | save plan |
| `tick()` with the Builder idle | first `ready` card, top-down | building | save plan, `builder.build(card, context, onEvent)` |
| outcome `done` | building | review | `checkpoint("fade: <title>")`, store the Review, `tick()` |
| outcome `stuck` | building | review | checkpoint `"fade: <title> (partial)"` if there are changes; Review has `question`; `tick()` |
| outcome `stopped` | building | draft, moved to the top | partial checkpoint if there are changes; append `> Stopped partway.` to the body |
| outcome `failed` | building | draft, moved to the top | set `builderError`; append `> Failed: <error>`; **no** automatic retry |
| `accept` | review | done | add `{ title, sha }` to `plan.done`, `shipped.count++`, remove the Review, toast "Shipped ✓" |
| `revise(note)` | review | ready, moved to the top | append `> Revise: <note>` to the body, remove the Review, `tick()` |
| `undo` | review | removed | remove the card and its Review; insert a ready card at the top titled `Undo: <title>` with the body: *"Revert the changes from commit <sha> ("fade: <title>") while keeping later work intact. Done when: that change is gone and the project still builds and passes its tests."*; `tick()` |
| `drop` | draft, ready or review | removed | (the UI confirms first) |
| `sendToBuilder` with the Builder idle | (none) | new **ready** card at the top | title = first line, max 48 chars, trimmed at a word boundary; body = the full text; `tick()` |
| `sendToBuilder` while building | (none) | (none) | `builder.note(text)`, push it to `building.notes` |

**Rules:**
- **Startup recovery:** any `building` card becomes `ready` and keeps its position. Reviews whose titles aren't in the plan are discarded.
- **External PLAN.md edits:** reload the plan. If a card is building in memory, keep it `building` even if the file says otherwise. If the building card was deleted from the file, re-insert it at the top when its outcome arrives.
- The `context` passed to `build()` is a short text: the titles of the next three cards in the plan, plus "Don't work on these."
- **Companion context** (passed with every `send`): see `formatCompanionContext` in section 10.
- `tick()` must never start a second build. Guard it with a `starting` flag as well as `builder.busy`.
- Every mutation calls `notify()`. The UI coalesces renders.

---

## 9. Pi integration (`src/agents/*`)

These are verified against the installed 1.0.4 typings. Check `node_modules/@earendil-works/pi-coding-agent/dist/core/*.d.ts` if tsc complains.

**Shared setup (`agents/pi.ts`):**

```ts
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime,
         SessionManager, defineTool, type AgentSession } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

export async function createRuntime() { return ModelRuntime.create(); }   // uses ~/.pi/agent auth, shared with the `pi` CLI

export function resolveModel(runtime: ModelRuntime, selector?: string) {
  if (!selector) return undefined;                  // Pi falls back to its default model
  const i = selector.indexOf('/');
  const model = i > 0 ? runtime.getModel(selector.slice(0, i), selector.slice(i + 1)) : undefined;
  if (!model) throw new Error(`Unknown model "${selector}". Use provider/model-id.`);
  return model;
}

export async function loader(cwd: string, rolePrompt: string) {
  const l = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(),
    appendSystemPromptOverride: base => [...base, rolePrompt] });
  await l.reload();
  return l;
}
```

**Creating a session:**

```ts
const { session } = await createAgentSession({
  cwd,
  modelRuntime: runtime,
  ...(model ? { model } : {}),
  tools: [/* built-in tool names */, /* your custom tool names too */],
  customTools: [/* defineTool(...) results */],
  resourceLoader: await loader(cwd, ROLE_PROMPT),
  sessionManager: SessionManager.continueRecent(cwd, join(cwd, '.fade', 'sessions', role)),
});
await session.bindExtensions({});
```

**Session API you'll use:**
- `session.prompt(text)` resolves when the run finishes. It throws if no model or API key is available. While streaming, use `session.steer(text)` (delivered before the next model call) or `session.followUp(text)`.
- `session.abort()` stops the run and waits for idle. `session.isStreaming` is a boolean. `session.getLastAssistantText()` returns the latest reply. Call `session.dispose()` on exit.
- `session.subscribe(event => …)` returns an unsubscribe function. Events:
  - `message_update`: `event.assistantMessageEvent.type === 'text_delta'` carries `.delta`. Accumulate the text yourself.
  - `message_end`: `event.message` (role `'assistant'`) is the final message. Its `content` is an array of blocks; join the `type === 'text'` blocks.
  - `tool_execution_start`: `{ toolCallId, toolName, args }`.
  - `tool_execution_end`: `{ toolCallId, toolName, result, isError }`.
  - `agent_end`: a run finished.

**Custom tools:**

```ts
const doneTool = defineTool({
  name: 'fade_done', label: 'Card done',
  description: 'Call when the card is finished and verified. This must be your final action.',
  parameters: Type.Object({ summary: Type.String(), howToTry: Type.String() }),
  execute: async (_id, params) => {
    outcome = { kind: 'done', summary: params.summary, howToTry: params.howToTry };
    return { content: [{ type: 'text', text: 'Recorded. Stop now.' }], details: undefined };
  },
});
```

**PiBuilder (`agents/builder.ts`):**
- Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Custom tools:
  - `fade_steps(steps: {text, status}[])` emits a `steps` event,
  - `fade_done(summary, howToTry)`,
  - `fade_stuck(question)`.
- **One long-lived session**, created in `init()` at startup (during the splash, so problems surface early) and reused for every card, so the Builder remembers the project. Pi compacts the context automatically.
- `build(card)`: reset `outcome`, `await session.prompt(cardMessage(card, context))`. Afterwards:
  - if `stop()` was called, return `stopped`;
  - otherwise return the recorded outcome;
  - if no tool was called, return `{ kind: 'done', summary: getLastAssistantText() ?? 'Finished.', howToTry: '' }`.
  - Wrap everything in try/catch and return `{ kind: 'failed', error: message }`.
- Map events to `BuilderEvent`s:
  - `tool_execution_start` → `action`, using a human verb: `read` → "reading <path>", `edit`/`write` → "editing <path>", `bash` → "running <first 40 chars of the command>", `grep`/`find`/`ls` → "searching". Show paths relative to the workspace. Also emit `log` with the full one-line description.
  - `tool_execution_end` with `isError` → `log` line prefixed `✗`.
  - Text deltas → `text`. `message_end` → `message`.
- `note(text)`: `session.steer("Note from the human: " + text)` if streaming; otherwise ignore it (the loop handles idle input).

**PiCompanion (`agents/companion.ts`):**
- Built-in tools: `read`, `grep`, `find`, `ls` **only**. Custom tools:
  - `fade_add_card(title, body)` → `planApi.addCard`, emits a `card` event,
  - `fade_edit_card(title, newTitle?, body?)`,
  - `fade_read_plan()` returns the serialized plan.
- A long-lived session, the same as the Builder's.
- `send(text, context)`: `prompt("<fade-context>\n" + context + "\n</fade-context>\n\n" + text)`. If it's already streaming, use `followUp` instead. Only the human's `text` is shown in the transcript.
- Stream text deltas as `text` events. `message_end` → `message`. Tool starts → `tool` ("reading src/app.ts"). Errors → `error`.

**Fakes (`agents/fake.ts`)** implement the same interfaces, with no network:
- **FakeBuilder:** emits 4 steps over about 6 seconds (`setTimeout`), writes a small file `fade-demo/<slug>.txt` in the workspace, then returns `done`. A card whose title contains "stuck" returns `stuck`. It honours `stop()`.
- **FakeCompanion:** streams a canned reply word by word (about 30 ms per word). If the message contains "card", it calls `planApi.addCard` with a title derived from the message.
- Make timings configurable (`speed` multiplier) so tests run instantly.

---

## 10. Prompts (`agents/prompts.ts`): use these as written

```ts
export const BUILDER_PROMPT = `
## You are the Builder in Fade
The human plans with a separate Companion while you build. You receive one card at a time from PLAN.md.

- Build exactly what the card describes. Decide routine details yourself; only ask when truly blocked.
- First call fade_steps with 3-7 short, human-readable steps (max 6 words each, e.g. "Read the note store").
  Update them with fade_steps as you progress (status: done / active / todo).
- Verify your work: run the project's existing tests, typecheck or build if they exist. Add a small test when reasonable.
- Finish by calling fade_done with:
  summary: 1-2 plain sentences about what changed,
  howToTry: one line telling the human how to see it working.
- If you cannot continue without a human decision, call fade_stuck with ONE clear question, then stop.
- Messages starting with "Note from the human:" may arrive mid-task. Take them into account.
- Never edit PLAN.md or anything inside .fade/. Never run git commit; Fade commits for you.
- Don't start long-running servers or watchers. If one is needed to try the work, say so in howToTry.
- Keep chat short. The human only glances at your pane.`;

export const COMPANION_PROMPT = `
## You are the Companion in Fade
You are the human's thinking partner while the Builder builds. Your job: help them figure out what they
actually want, and turn it into great cards in PLAN.md.

How you talk:
- Like a sharp, warm senior collaborator. Short replies (2-6 sentences) unless they ask for depth.
- One good question beats five. Have opinions. Offer concrete options ("A or B? I'd pick A because...").
- Point out vagueness or contradictions kindly. No flattery, no filler, no generic praise.

Cards:
- When an idea is concrete enough to build in one go (roughly 5-30 minutes of Builder work), offer to make it
  a card, or just make it if they asked. Use fade_add_card.
- A good card: a title of at most 5 words; a body of 1-4 sentences describing the outcome; and a final line
  "Done when: <observable check>".
- Split big ideas into several small cards. Refine existing cards with fade_edit_card.
- Never mark cards ready. That's the human's call: they press Space in the Plan. You may remind them once.

Project:
- You can read the project (read, grep, find, ls). Look before making claims about the code.
- You cannot change files or run commands.
- Each message starts with a <fade-context> block (current build, review queue, plan). Use it; don't recite it.`;

export function cardMessage(card: Card, context: string): string;          // "Card: <title>\n\n<body>\n\n<context>"
export function formatCompanionContext(view: FadeView): string;
// Building: "<title>" (steps: ✓ a, ◌ b, ○ c) | Builder idle
// To review: one line per review: "<title>: <summary>" (or "STUCK: <question>")
// Plan: one line per card: "[state] title"
// Recently done: the last 3 done titles
```

---

## 11. The UI

### 11.1 Theme (`ui/theme.ts`)

Truecolor ANSI helpers: `fg(hex)(text)`, `bg(hex)(text)`, `bold`, `dim`. If `NO_COLOR` is set, every helper returns plain text.

| Name | Hex | Use |
|---|---|---|
| `bg` | `#121416` | Painted behind every line of the app |
| `text` | `#F5F4DE` | Warm ivory: body text |
| `mint` | `#A6EFDC` | Accent: focus borders, Builder, ✓, active items |
| `lavender` | `#BE9EF0` | Secondary: "you" labels, "needs you" highlights |
| `muted` | `#A4ABBE` | Labels, hints |
| `faint` | `#5C6370` | Unfocused borders, dividers, draft cards |
| `rose` | `#F2A7A7` | Errors only |

**Glyphs:** draft `·`, ready `○`, building `◌`, review `◆`, done `✓`. Spinner frames: `◜ ◠ ◝ ◞ ◡ ◟`, 100 ms each.

`sanitize(text)` strips ANSI and control characters from model output before rendering. Keep `\n` and `\t`. Use:

```ts
text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
```

Every rendered line must be exactly `width` visible columns. Use `truncateToWidth(line, width, '…', true)` from pi-tui (the last argument pads). Then wrap the whole line in `bg('#121416')`. Re-apply the background after any `\x1b[0m` or `\x1b[49m` inside the line, so it stays continuous.

### 11.2 Logo (`ui/logo.ts`): the brand, get this right

The reference image is `docs/assets/fade-logo.webp`:
- "FAD" is drawn in ivory square tiles.
- "E" is drawn in mint tiles.
- Tiles then scatter to the right, mint first, then lavender, getting sparser like dust.

In the terminal, each tile is two columns: `▐█`. A colored underline in the background color fakes the thin gap between tile rows. Use this proven implementation verbatim:

```ts
const LETTERS = [
  ['11111', '11111', '11000', '11110', '11110', '11000', '11000'],          // F
  ['011110', '111111', '110011', '111111', '111111', '110011', '110011'],   // A
  ['111110', '111111', '110011', '110011', '110011', '111111', '111110'],   // D
  ['11111', '11110', '11000', '11111', '11010', '11111', '11111'],          // E (already breaking apart)
];
const TRAIL = [
  'M  M  M    M    M   M           ',
  ' M  M   M     M    L    M       ',
  'M  M   M  M      L    L      L  ',
  ' M   M   M   M    L      L      ',
  'M   M   M   M   L    L     L    ',
  '  M   M    M   M   L   L    M   ',
  'M   M   M    M   L    L   L     ',
];
const NEAR_EDGE = [' ', 'M', ' ', 'M', ' ', 'M', ' '];                       // fragments hugging the E
const NEAR_TRAIL = ['M M ', ' M M', 'M M ', ' MM ', 'M M ', ' M M', 'M M '];

function tile(color: (s: string) => string, bgRgb = '18;20;22'): string {
  return color(`\x1b[4m\x1b[58;2;${bgRgb}m▐█\x1b[24m\x1b[59m`);
}

/** 7 rows. Each letter cell = one tile (2 columns); letters are separated by one empty tile. */
export function wordmark(width: number, twinkleSeed?: number): string[] {
  if (width < 76) return [compactMark()];
  const trailTiles = Math.min(32, Math.max(0, Math.floor(width / 2) - 26));
  return LETTERS[0]!.map((_, row) => {
    const letters = LETTERS.map((letter, i) =>
      [...letter[row]!].map(c => c === '0' ? '  ' : tile(i < 3 ? fg(IVORY) : fg(MINT))).join('')
    ).join('  ');
    const near = NEAR_TRAIL[row]!;
    const trail = [...(near + TRAIL[row]!.slice(near.length))].slice(0, trailTiles)
      .map((c, col) => c === 'M' ? tile(fg(MINT)) : c === 'L' ? tile(fg(LAVENDER)) : '  ').join('');
    return letters + (NEAR_EDGE[row] === 'M' ? tile(fg(MINT)) : '  ') + trail;
  });
}

/** One line for headers: "FADE" + a tiny dissolving trail. */
export function compactMark(): string; // bold ivory "FAD" + bold mint "E" + mint "▪ ▪" + lavender " ▫  ·"
```

**Twinkle (Phase 4):** when `twinkleSeed` is given, use a cheap deterministic hash of `(row, col, seed)` so about 8% of the trail tiles swap mint↔lavender or blink empty. The splash advances the seed every 140 ms, so the dust gently shimmers. Letter tiles never change.

Compare your rendering with the reference image using `scripts/snapshot.ts`. Make sure the letters read clearly as **F A D E**.

### 11.3 Screen layout: wide (≥ 100 columns)

Render exactly `tui.terminal.rows - 1` lines.

```
 FADE ▪ ▪ ▫  ·   notes-app · main                           builder · claude-sonnet  companion · claude-opus
───────────────────────────────────────────────────────────────────────────────────────────────────────────
 BUILDER  Search                              ◌ 03:12 │ COMPANION
                                                      │
 ✓ Read the note store                                │ you        Could it feel more like a notebook?
 ✓ Added a search index                               │
 ◌ Wiring search into the sidebar                     │ companion  Warm paper, roomy margins, quiet
 ○ Run the tests                                      │            controls. Make it a card?
   └ editing src/sidebar.tsx                          │
                                                      │ you        yes, keep it one column
 I'll wire the index into the sidebar next.           │
                                                      │            + Notebook styling  (draft)
 you › use fuzzy matching please                      │
 ──────────────────────────────────────────────────── │ ───────────────────────────────────────────────────
  note to builder…                                    │  › what about typography?▌
 ──────────────────────────────────────────────────── │ ───────────────────────────────────────────────────
───────────────────────────────────────────────────────────────────────────────────────────────────────────
 TO REVIEW  ◆ Core notes app · 5 files                            ⏎ look   a accept   r revise   u undo
 UP NEXT    ○ Export to markdown   · Notebook styling   · Tags                            shipped today 2
───────────────────────────────────────────────────────────────────────────────────────────────────────────
 tab focus · enter send · esc stop · ctrl+r review · ? help
```

- **Header row:** `compactMark()`, the workspace folder name, the git branch (muted), and the model names on the right (muted; just the model id, not the provider).
- **Panes:** split 50/50 with a faint `│` divider. Each pane has a header line (`BUILDER` in mint bold / `COMPANION` in lavender bold), content, and at the bottom a pi-tui `Editor` (it draws its own top and bottom rules). The focused pane's editor `borderColor` is mint; unfocused is faint. The focused pane's header gets a small mint `●` after the name.
- **Builder pane content, top to bottom:**
  1. Header: the card title, and on the right a spinner + elapsed `mm:ss` while building. When idle, show `idle` (muted).
  2. The step list: done steps `✓` mint, the active step `◌` mint (spinner), todo `○` faint text.
  3. `  └ <action>` in muted.
  4. A blank line, then the last Builder message (sanitized, wrapped, at most 6 lines, ivory) or the live streaming text.
  5. Recent human notes: `you › <note>`, with "you ›" in lavender.
  6. `builderError` in rose, if set.
  - **Idle with nothing ready:** show a calm empty state: `Builder is free.` (ivory) and `Type a task below, or mark a card ready (tab → plan, space).` (muted).
  - **Ctrl+L** toggles a raw view showing the last N `builderLog` lines instead of items 4–5.
- **Companion pane content:** the transcript.
  - `you` entries: a lavender label column, then the text.
  - `companion` entries: a mint label, then the text rendered with pi-tui `Markdown`. Build one `Markdown` instance per entry and cache it; the theme uses the palette.
  - `card` entries: `+ <title>  (draft)` in mint, indented.
  - `tool` entries: `reading src/app.ts` in faint, indented.
  - `error` entries: rose.
  - `companionLive` is shown as the last companion entry while streaming.
  - **Empty state:** the big wordmark if it fits (pane width ≥ 76 and height ≥ 16), then `What are we making?` in ivory.
- **Scrolling:** PageUp/PageDown scroll the focused pane. Follow the bottom automatically unless the user has scrolled up. While scrolled up, show a faint `↓ new` hint on the last content line.
- **Bottom strip** (always 2 lines between rules):
  - `TO REVIEW`: label in lavender bold when there's anything to review, otherwise faint. Shows the first review card (`◆ title · N files`, or `◆ title · needs your answer` when stuck), plus `+N more` if there are others. With nothing to review, show `nothing to review` in faint. The `⏎ look a accept r revise u undo` hint is bright only when Plan is focused, faint otherwise.
  - `UP NEXT`: the building card is not listed; the ready and draft cards are, in order, with their glyphs, separated by three spaces, and truncated with `…`. `shipped today N` is right-aligned in muted. If the Builder is idle and nothing is ready, this line says `Builder is free: mark a card ready (space) or tell it what to do` in lavender.
- **Hint line:** faint, and changes with the focus.

### 11.4 Plan focus

When Plan is focused, the strip grows into a list (up to 40% of the height; the panes shrink):

```
 PLAN                                     ↑↓ select  space ready  ⏎ open  n new  alt+↑↓ move  x drop
 ◆ Core notes app          review    npm start, add a note, reload: it's still there
 ◌ Search                  building
›○ Export to markdown      ready
 · Notebook styling        draft
 ✓ Project setup           done
```

- The selected row has a mint `›` and bold text.
- For review rows, the third column shows `howToTry`, or `? <question>` for stuck cards. For other rows it shows the first line of the body (faint).
- Show done entries at the bottom: the last 3, faint.

### 11.5 Narrow layout (< 100 columns)

One pane at a time, with a tab row under the header: `Builder ◌   Companion   Plan`. The focused tab is mint and underlined, the others faint, and `◌` appears next to Builder while it's building. The bottom strip still shows its two lines. Below 60×16, render only: `Fade needs a slightly bigger window (60×16).`

### 11.6 Keys (the complete list)

| Key | Where | Action |
|---|---|---|
| Tab / Shift+Tab | anywhere (no overlay) | Focus Builder → Companion → Plan |
| Enter | Builder / Companion | Send the editor text (ignore empty input) |
| Esc | Builder | Stop the current card (toast "Stopping…") |
| Esc | Companion | Stop the current reply |
| Esc | overlay | Close it |
| Ctrl+R | anywhere | Open the first review card's overlay |
| Ctrl+L | anywhere | Toggle the raw Builder log |
| PageUp / PageDown | Builder / Companion | Scroll the transcript |
| ↑ ↓ (or k j) | Plan | Select |
| Space | Plan | Toggle ready / draft |
| Enter | Plan | Review card → review overlay; draft/ready card → card editor |
| n | Plan | New card (title prompt, then the editor) |
| Alt+↑ / Alt+↓ (or K / J) | Plan | Move the card |
| x | Plan | Drop the card (confirm y/n) |
| a / r / u | Plan (on a review card) or review overlay | Accept / revise (a note prompt) / undo (confirm) |
| ? or F1 | Plan, or any empty editor | Help overlay |
| Ctrl+C | anywhere | Clears a non-empty editor; otherwise "Press Ctrl+C again to quit", and a second press within 1 s quits |

Use `matchesKey(data, 'tab' | 'shift+tab' | 'escape' | 'enter' | 'space' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'alt+up' | 'alt+down' | 'ctrl+r' | 'ctrl+l' | 'ctrl+c' | 'f1')` from pi-tui. Root `handleInput` order: an open overlay first, then global keys, then the focused pane (forward to the focused `Editor.handleInput`).

### 11.7 Overlays (`ui/overlays.ts`)

Use `tui.showOverlay(component, { width: '80%', maxHeight: '80%', anchor: 'center' })`. It returns a handle with `hide()`. Each overlay is a small `Component` with `render(width)` and `handleInput(data)`, drawn as a rounded faint box (`╭─╮│╰─╯`) with a mint title.

- **Help:** the keys table, grouped, plus `compactMark()` at the top.
- **Review:** the title, the summary, `Try it: <howToTry>`, or for stuck cards `Question: <question>` in lavender. Then the `git show` output, sanitized of everything except SGR colors, scrollable with ↑↓/PgUp/PgDn. Footer: `a accept · r revise · u undo · esc close`.
- **Card editor:** a pi-tui `Editor` prefilled with `Title\n\nBody`, with `disableSubmit = true`. Ctrl+S saves (first line = title, the rest = body); Esc cancels. Footer: `ctrl+s save · esc cancel · alt+enter newline`.
- **Text prompt:** a one-line `Editor`. Enter submits; Esc cancels. Used for the revise note and new card titles.
- **Confirm:** `<question>  y / n`.

### 11.8 Splash (`ui/splash.ts`)

While the agents initialise, show the big `wordmark()` centered on the screen with its twinkle, `A tool for the mind.` in muted below it, and a mint spinner with `warming up…`. Leave the splash when init finishes **and** at least 900 ms have passed, or immediately on a keypress once init is done. If init fails, stay on the splash and show the error in rose, plus how to fix it.

### 11.9 Fade-out on accept (Phase 4)

When a card is accepted, keep a `fading` entry `{ title, start }` in the UI for 700 ms. Wherever that card was listed, render its title dissolving: characters are progressively replaced from right to left by `▓ ▒ ░ ·`, while the color shifts ivory → mint → lavender → faint, after which the entry is gone. Drive this with a 50 ms render timer that runs only while something is fading. This is the brand moment, so make it smooth.

### 11.10 Rendering mechanics

- `const terminal = new ProcessTerminal(); const tui = new TuiMainScreen(terminal);`. Then `tui.addChild(root); tui.setFocus(root); tui.start();`. The root's `handleInput` routes keys itself. Set `editor.focused = true/false` yourself on the two editors so the cursor shows in the right one.
- Re-render through `fade.onChange(() => tui.requestRender())`, plus a 100 ms interval **only while** a spinner is visible.
- On quit, `tui.stop()`, dispose both agents, flush state, then `process.exit(0)`.
- Keep `render()` fast: no file or git I/O in `render`. Get the branch name once at startup.

---

## 12. CLI (`src/cli.ts`)

```
fade                      run in the current directory
fade --demo               run in a temp folder with fake agents (no API calls); great for trying the UI
fade login                open Pi's login (spawns Pi's CLI so the user can /login), then exit
fade --builder <p/m>      Builder model, e.g. anthropic/claude-sonnet-...
fade --companion <p/m>    Companion model
fade --help | --version
```

**Startup sequence for `fade`:**
1. If the directory isn't a git repo, ask on plain stdin (before the TUI starts): `Fade uses git to checkpoint each card. Initialize a repo here? (Y/n)`. On "no", exit with a short explanation.
2. Run `git.excludeFade()`.
3. `runtime = await ModelRuntime.create()`. If `(await runtime.getAvailable()).length === 0`, print `No models available yet. Run "fade login" to connect a provider (it uses Pi), then run fade again.` and exit with code 1.
4. Start the TUI with the splash, `await Promise.all([builder.init(), companion.init()])`, `fade.start()`, then show the workspace.

**Models:** CLI flag, else `.fade/config.json` `{ "builder": "...", "companion": "..." }`, else Pi's default.

**`fade login`:** resolve Pi's CLI with `fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))` (this points at `.../dist/index.js`) → its directory → `bundle/cli.js`. Check that the file exists, then run `spawnSync(process.execPath, [cliPath], { stdio: 'inherit' })` with a printed hint: `Type /login, pick a provider, then /quit.` If resolution fails, print `npx @earendil-works/pi-coding-agent` as the fallback.

**Demo:**
1. Make a temp dir and `git init` it (set a local `user.name`/`user.email` so commits work).
2. Write a sample `PLAN.md` with: one review card (and a fake Review with a real checkpoint commit), two ready cards, and two drafts.
3. Seed the Companion transcript with one short exchange.
4. Run with `FakeBuilder`/`FakeCompanion`.

Add `#!/usr/bin/env node` to the top of `cli.ts` so `dist/cli.js` is executable.

---

## 13. Phases (build them all, in order)

After **each** phase, run the verification commands and fix everything before moving on:

```bash
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
node --import tsx scripts/snapshot.ts
```

**Look at the snapshot output yourself** every time you touch the UI. It's your only eyes.

**Phase 1: the loop, with a simple UI.** `types`, `plan`, `state`, `git`, `loop`, `agents/*` (real and fake), `cli` (without the splash), and a temporary single-column UI listing the plan, the Builder steps and the Builder feed. Tests: `plan.test.ts` (round trip, hand-edited input, duplicate titles, unknown states, preamble kept) and `loop.test.ts` (every row of the transitions table, using fakes at instant speed, a temp git repo, and asserting commits exist). Write `scripts/live-smoke.ts`: in a temp git repo with a one-card plan ("Create hello.txt containing hi. Done when: the file exists"), run the real `PiBuilder` and print the outcome and the commit. Run it **only if** models are available. Report the result honestly, failures included.

**Phase 2: the Fade screen.** The full wide and narrow layout, the theme, panes, editors, bottom strip, Plan focus, every key and every overlay. Delete the temporary UI. `render.test.ts`: render the main states (empty, building, review waiting, idle with no ready cards, Plan focused, narrow) at 120×40 and 80×24 with fakes. Assert that every line's `visibleWidth` equals the width, that the line count equals rows − 1, and that key labels are present. `scripts/snapshot.ts` prints the same states as plain text, with ANSI stripped.

**Phase 3: the Companion as co-author.** The card tools wired into the plan, `formatCompanionContext`, card and tool entries in the transcript, the transcript persisted in state and restored on restart, and the Markdown rendering cache. Polish the prompts only if something is clearly broken.

**Phase 4: feel pass.** The splash with twinkle, the fade-out on accept, the `shipped today` counter, the idle nudge, the stuck flow in the review overlay, the help overlay, the empty states, resize handling (re-render on resize with nothing broken at any size down to 60×16), and the `↓ new` scroll hint. Then go through the whole UI in snapshots and fix anything misaligned, noisy or ugly. Less text is better.

**Phase 5: ready to share.**
- **`README.md`:** the hook line *"Plan the next thing while AI builds this one."*; a placeholder for a GIF (`docs/assets/demo.gif`, to be recorded by the human from `fade --demo`); a 3-step quick start (`npm i -g`, `fade login`, `fade`); the mental model (3 things, 5 states); the keys table; how PLAN.md works; and a short "Why" section built on *"Code is cheap now. Clarity isn't."*
- **`.github/workflows/ci.yml`:** Node 22 on ubuntu and windows, running the typecheck and tests.
- Make sure `node node_modules/typescript/bin/tsc -p tsconfig.json` builds `dist/` and that `node dist/cli.js --help` works.

---

## 14. Definition of done

- [ ] Typecheck, tests and build pass. Snapshots render every state cleanly at 120×40 and 80×24.
- [ ] `fade --demo` shows the splash with the logo, then the workspace. Fake cards build, land in review, and accept with the fade-out animation.
- [ ] Typing in either pane never lags while both fakes stream. Focus never moves on its own.
- [ ] PLAN.md edited by hand while Fade runs is picked up live.
- [ ] Every agent or git failure path shows a one-line human message and never crashes.
- [ ] No file over 400 lines, no `any`, no `console.log` while the TUI runs.
- [ ] Live smoke run, if models are available, with the result reported.

## 15. Final report (keep it short)

1. What works (per phase).
2. Anything you couldn't do or simplified (`// NOTE:` items).
3. The live smoke result.
4. Exact commands for the human to try it: `npm run demo`, then `fade` in a real project.
