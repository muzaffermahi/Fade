# Fade

**A tool for the mind.** Think about your software's future while Pi builds its present.

Fade extends Pi with a thoughtful Companion, source-backed Living Intent, and a parallel Builder that implements bounded slices from stable snapshots. The Companion is the real Pi session: it can inspect files, search the project, execute commands, and make requested edits. Ordinary prompts automatically enter Fade's loop.

This independent project lives in `Fade`. The product, folder, global command, and public GitHub repository are named **Fade**. The older parent project is preserved.

## Install and run

Requires Node 22.19 or newer and Bash (Git for Windows provides Bash). Development uses Node 24.

```powershell
npm ci
node node_modules/typescript/bin/tsc -p tsconfig.json
npm link --ignore-scripts
```

Open a terminal in your project and run:

```powershell
Fade
```

The launch directory is the workspace. On Windows, `fade` also works. Use `Fade --workspace <directory>` or `--idea "your idea"` when needed. Piped input uses the line interface; `--plain` selects it explicitly.

## Pi interface and capabilities

Fade uses **Pi 1.0.4's actual InteractiveMode**, with a Fade header. The Companion streams natural prose and real tool calls through that session. It retains Pi's read, bash, edit, and write tools; configured extra tools; extensions and packages; skills; prompt templates; project instructions; MCP; tool search; and codemode. Discovery uses Pi's ordinary configuration and resource loader.

Use the native editor, history, themes, keybindings, image input, `/settings`, `/model`, `/login`, `/new`, `/resume`, `/tree`, `/fork`, `/compact`, `/reload`, and shell input (`!` and `!!`). Pi's session context, tool results, and token counters describe the actual Companion. Native sessions are saved under `.fade/sessions/conversation`; the latest session resumes on launch. Session changes preserve the workspace's Living Intent, and changing to a different workspace mounts that workspace's Fade state. Recovery leaves implementation paused; `/continue` restarts it.

The Companion uses Pi tools when you ask it to read or inspect something. It does not require you to paste readable files. For an existing project or an inspection request, the initial Builder inspects before acting and does not invent a new skeleton. The concurrent Builder still receives a bounded immutable brief; the Companion is instructed to avoid overlapping its edits.

## Models and credentials

Fade follows Pi's configured model selection, `~/.pi/agent/auth.json`, and `models.json`. It has **no preferred provider or model**. `/model` changes future turns for both roles unless you explicitly override the Builder. Authentication, thinking levels, and provider configuration use Pi's normal mechanisms.

Optional role overrides:

```powershell
Fade --builder <provider/model-id> --companion <provider/model-id>
```

`FADE_BUILDER_MODEL` and `FADE_COMPANION_MODEL` provide the same overrides. Each OpenCode Go session supplies its routing header. DeepSeek V4.1 Flash is selected explicitly for recorded cloud tests only.

## Talk to both roles

Ordinary chat goes to the Companion. Use `/builder <message>` to address the current Builder through Pi's normal steering queue. Notes are saved before delivery; `pending`, `queued`, and `received` are distinct receipts. Received means the note entered the Builder's Pi context. If there is no active Builder, it waits for the next slice. Unreceived notes survive interruption and recovery. Notes do not silently change the fixed brief; `/redirect` is the explicit scope change.

`/builder` alone shows the current work and receipts. `/reports` shows the latest Companion reply plus Builder summaries, reported checks, and findings. `/log` shows actual tool operations and results without transport JSON. Builder completion reports also appear automatically in the native transcript. `/companion <message>` is an explicit alias for ordinary chat.

## Fade controls

| Command | Purpose |
| --- | --- |
| `/intent` | Show intent and prepare editable `intent-edit.json` |
| `/apply-intent` | Apply edits if their revision is current |
| `/status` | Inspect current and future implementation |
| `/builder [message]` | Show present work or send a durable Builder note |
| `/companion <message>` | Address the Companion explicitly |
| `/reports` | Read both roles' reports and Builder verification claims |
| `/pause`, `/stop`, `/continue` | Control the Builder while keeping conversation available |
| `/redirect <thought>` | Interrupt the active slice and develop a new direction |
| `/rethink` | Reconcile discoveries, edited intent, or a failed conversation |
| `/history`, `/log` | Inspect Fade conversation or actual Builder events |
| `/preference design` or `/preference technical` | Set conversation emphasis |
| `/quit` | Save, cancel active work, and exit |

Escape interrupts Fade work from the main editor; native menus and autocomplete retain their normal Escape handling. The Builder footer shows progress while its completion summary appears in the conversation. Ordinary work does not require a Fade command approval gate. A run has a four-slice ceiling; `/continue` resets it.

The line interface retains `/write`, `/send`, `/cancel`, `/editor`, `/resume`, `/reload`, and `/models` for scripts and plain terminals. Interactive use defaults to Pi's native TUI.

## The loop

1. Every ordinary input is saved before processing. The first request starts a bounded Builder slice alongside the Companion.
2. The Companion uses Pi normally and may call `fade_update_intent` to propose exact human quotes, unresolved questions, and one future slice. Its prose streams independently of this metadata.
3. The coordinator validates provenance and revisions. Tentative ideas remain tentative; contradictory statements remain visible conflicts. An explicit reversal preserves source history.
4. A ready future slice automatically follows completed dependencies using a fixed intent snapshot. Conversation cannot silently rewrite the active brief.
5. Discoveries hold affected future briefs for reconciliation against existing human intent. They cannot create new human decisions.

The Builder reports structured results; malformed results get one format-only repair with implementation tools disabled. Its summaries and verification strings remain model claims alongside real execution events.

## Persistence and implementation

`.fade/journal.jsonl` is the durable source of recovery state. Atomic `state.json`, readable `intent.md`, revision-checked edits, and separate Pi session files preserve conversation, intent, and slice history. `builder-events.jsonl` retains actual tool calls and results. An interrupted final journal append is preserved and ignored during recovery. A workspace lock prevents two Fade instances from modifying its state.

| File | Responsibility |
| --- | --- |
| `src/cli.ts`, `src/plain.ts` | Global command and line fallback |
| `src/tui.ts` | Real Pi conversation, native tools, branding, and intent metadata tool |
| `src/pi-resources.ts` | Pinned Pi CLI's complete built-in extension set |
| `src/app.ts` | Durable input queue, Fade commands, shutdown |
| `src/coordinator.ts` | Stable slices, handoffs, provenance, conflicts, cancellation |
| `src/pi.ts` | Separate native Pi Builder and line-interface Companion sessions |
| `src/contracts.ts`, `src/store.ts` | Validated payloads and persistence |

Pi packages are pinned consistently to 1.0.4 to avoid mixing incompatible runtime types. The built-in extension loader uses that pinned SDK's internal CLI extension manifest because Pi does not export the full set publicly; the loader validates its shape and fails visibly if it changes.

## Verification

```powershell
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json
node dist/cli.js --help
```

Tests cover coordination, source provenance, tentative/conflicting intent, immutable snapshots, discoveries, stale replies, failures, cancellation, recovery, locks, native input routing, queue durability, real read/write/edit tools, shell execution, session navigation, model selection, and project resource discovery. Model transport is simulated in deterministic tests; Pi's tools and loop are real.

Opt-in cloud tests:

```powershell
node --import tsx scripts/live-exchanges.ts
node --import tsx scripts/live-native.ts
node --import tsx scripts/live-smoke.ts
```

Set both role model environment variables explicitly. The native test writes an undisclosed marker to an essay, asks the Companion to read it with its tools, verifies the answer, and executes a native shell command. The second test checks a real Builder A → B transition and generated code. The exchange test goes back and forth three times with the Companion while sending a separate Builder note, verifies its receipt, and reads both reports. These scripts make model calls in temporary workspaces.

## Limits

Pi tools execute with the user's normal permissions. Builder scope and avoidance of concurrent edits are instructions, not an OS sandbox or transactional filesystem isolation. Interpretation still depends on the model: exact source quotes do not guarantee faithful meaning. Native history uses Pi's normal context and compaction, while Living Intent retains settled meaning separately. The plain interface still buffers structured replies. The snapshot journal grows with project history. See `IMPLEMENTATION_STATUS.md` for observed checks.
