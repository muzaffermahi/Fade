# Fade

**A tool for the mind.** Think about your software's future while Pi builds its present.

Fade is a small, local terminal experiment in human authorship. The main conversation is with a thoughtful Companion, not a task dispatcher. Your writing becomes evidence-backed Living Intent. A separate Pi Builder implements bounded slices from fixed snapshots of that intent. Future slices can begin automatically when sufficiently clear.

This is an independent project in the requested `Veto2` folder. It does not reuse or modify the older parent repository. The product and GitHub repository are named **Fade**.

## Install and run

Node 22 or newer is required. Node 24 was used for development. Pi's bash tool needs Bash; on Windows install Git for Windows and make its Bash available on PATH.

```powershell
cd C:\Users\LENOVO\Documents\ChatGPT\Apple-of-my-ai\Veto2
npm ci
node node_modules/typescript/bin/tsc -p tsconfig.json
node dist/cli.js --workspace .\projects\my-notebook
```

Write your idea at the prompt. Pi starts the foundation while the Companion explores what matters to you. `/write` opens a multiline composition mode; `/send` submits it. `/cancel` retains the draft. You can also set `FADE_EDITOR` to an editor executable (such as `notepad.exe`) and use `/editor`.

```powershell
node dist/cli.js --workspace .\projects\my-notebook --idea "Build a calm notebook for unfinished thoughts"
```

Restart with the **same workspace** to recover its conversation, intent, decisions, discoveries, slice results, and Pi session references. It opens paused; `/resume` continues. Interrupted work is retried using a new current intent snapshot, with existing code preserved. Use a dedicated workspace for projects you authorize Pi to modify.

## Models and credentials

Fade uses Pi's existing `~/.pi/agent/auth.json` and `models.json`. Both roles default to **OpenCode Go / DeepSeek V4.1 Flash**, as requested for this experiment. No keys are hardcoded or copied into project files. Authenticate through Pi's normal `/login` or the provider's environment variable. `/models` lists models with configured authentication; this is not a connectivity check.

Builder and Companion models can be configured independently:

```powershell
node dist/cli.js --workspace .\projects\notes --builder opencode-go/deepseek-v4.1-flash --companion opencode-go/deepseek-v4.1-flash
```

Alternatively set `FADE_BUILDER_MODEL` and `FADE_COMPANION_MODEL` to `provider/model-id`. The model must support structured JSON; the Builder also needs reliable tool calling. The pinned Pi catalog predates V4.1 Flash, so Fade adds that official model ID using the existing Go OpenAI-compatible transport and conservative catalog limits. Every Go session sends its own `x-opencode-session` header. Neither compatibility adjustment rewrites your Pi configuration. [Official OpenCode Go model documentation](https://opencode.ai/docs/go/).

Fade disables automatic discovery of Pi extensions, packages, skills, prompt templates, and ancestor context files. This keeps the two roles separate and prevents the older project's instructions from leaking into generated projects. The Builder is instructed to read instructions inside its authorized application workspace.

## Daily use

| Command | Purpose |
| --- | --- |
| `/write`, `/send`, `/cancel` | Compose substantial freeform thoughts |
| `/editor` | Compose in your configured external editor |
| `/intent` | Read intent and create an editable `intent-edit.json` |
| `/reload` | Import edits if their revision is still current |
| `/status` | Inspect current and upcoming implementation |
| `/history`, `/log` | Read conversation or actual Pi execution events |
| `/pause`, `/stop`, `/resume` | Control implementation while keeping conversation available |
| `/redirect <thought>` | Explicitly interrupt the current slice and develop a new direction |
| `/rethink` | Reconcile discoveries, imported edits, or retry a failed conversation |
| `/preference design` or `/preference technical` | Adjust conversational emphasis |
| `/allow <id>`, `/deny <id>` | Resolve a specific nonroutine shell request |
| `/quit` | Cancel active work, save, and leave |

There is no approval ceremony for ordinary file changes or ready slices. Each run has a four-slice ceiling; `/resume` resets it. Fade never polls models for progress. When you leave it alone, it implements already-defined work and then waits.

## How the loop works

1. The first idea starts a bounded walking skeleton and an independent Companion conversation.
2. The Companion responds naturally and proposes structured evidence from your current message. Exact source quotes are required. Exploratory language is conservatively retained as tentative rather than binding.
3. A single upcoming slice holds concrete requirements, relevant decision keys, dependency IDs, and assumptions. Only active settled decisions can support an automatic handoff.
4. The Builder receives an immutable intent snapshot. Mid-slice conversation never silently rewrites that brief.
5. Completion enables a ready dependent slice. Important discoveries hold affected future briefs for reconciliation; unrelated briefs can continue. A single event-triggered Companion response attempts to reconcile an affected brief against existing intent, without creating new human decisions or an approval ceremony.

Contradictory statements stay visible as conflicts. An explicit reversal can supersede them with provenance preserved. Stale Companion deltas are held rather than overwriting an intent edit or implementation discovery that arrived during the model response. `/rethink` uses the latest context. Malformed model JSON gets one format-only repair attempt with code tools disabled, then fails visibly if still invalid.

## Architecture and files

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | Event-driven terminal conversation, writing modes, controls and shell consent |
| `src/coordinator.ts` | Rolling slices, stable snapshots, evidence, conflicts and cancellation |
| `src/pi.ts` | Actual Pi SDK sessions; scoped Builder tools; tool-less Companion |
| `src/prompts.ts` | Dedicated product philosophy and Builder boundaries |
| `src/contracts.ts` | TypeBox schemas, Ajv validation and strict domain types |
| `src/store.ts` | Durable journal, atomic snapshots, Markdown intent and process lock |
| `src/workspace.ts` | Canonical file path guards and conservative shell command gate |
| `tests/coordinator.test.ts` | Focused deterministic coordination and persistence tests |
| `tests/cli.test.ts` | Actual terminal launch, writing mode, recovery, intent display and exit |
| `scripts/live-smoke.ts` | Opt-in real Pi A → B end-to-end exercise |

Each project owns a `.fade/` directory. `journal.jsonl` retains the complete state after each transition and is authoritative for recovery; a truncated final append is preserved separately and ignored. `state.json` is an inspectable snapshot. `intent.md` presents the readable Living Intent. `/intent` creates an editable copy whose revision is checked by `/reload`; background persistence never overwrites that edit. `builder-events.jsonl` retains real Pi tool calls/results and completed messages. Pi session files remain separate for each role and execution. Each model turn receives concise explicit context; the full underlying history remains on disk.

## Verification

```powershell
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json
node dist/cli.js --help
```

The automated suite uses a simulated adapter only for model execution. It verifies overlap, A → B without approval, source provenance, tentative decisions, conflict/reversal, changed assumptions, stale responses, API failure, cancellation, resume, persistence, partial journal recovery, workspace locks, and symlink/path escape.

Real integration test (makes actual model calls and runs code in a temporary folder):

```powershell
node --import tsx scripts/live-smoke.ts
```

It defaults to `opencode-go/deepseek-v4.1-flash` for both roles; use the two `FADE_*_MODEL` variables to select other configured models. See `IMPLEMENTATION_STATUS.md` for observed results and remaining limitations.

## Limits of this experiment

- Shell commands and generated code run with your OS permissions. Canonical file tool paths and command screening are useful guardrails, **not an OS sandbox**. Common local checks run automatically; nonroutine commands require explicit consent. Use only trusted projects and inspect a requested command before allowing it. No deployment or publishing tool is provided.
- Builder summaries and verification strings are model claims. Actual tool results are retained for inspection; Fade does not independently prove every claim or enforce semantic truth.
- Decision extraction and recognition of changed assumptions still depend on the model. Exact quotes, conservative tentative classification, stable keys, and schema checks reduce risk, but cannot guarantee that an interpretation matches your thinking.
- Context is intentionally concise: the latest 12 conversation entries and relevant slices/discoveries supplement accumulated intent. Nuance from a long conversation can be lost if not represented in Living Intent. Full history is preserved, but not automatically reread each turn.
- Structured replies are buffered until valid JSON is complete. Builder activity is event-driven; Companion token streaming and a full terminal editor are deferred.
- The journal stores full snapshots, so it grows with conversation history. This is local MVP persistence, not a large-project storage design.
- The explicitly requested `@mariozechner/pi-coding-agent@0.73.1` is deprecated upstream in favor of `@earendil-works/pi-coding-agent`. `npm audit` reports upstream advisories for this package and its dependencies. Package installation/discovery and HTML export features implicated in several advisories are disabled/unused here; this does not make all upstream advisories resolved. A migration to the maintained SDK needs its own API compatibility work.

The biggest interaction weakness is interpretation: a model can flatten a nuanced thought into an overly crisp requirement. Fade exposes the source words and tentative/conflict states so you can see and correct that translation. Whether it helps you think more deeply still needs real human use.
