# Fade implementation status

Current verification uses Pi 1.0.4 with the real Companion engine and tools. Earlier rows and evidence below are historical; the final section records the current implementation.

| Work order | Status | Command summary |
| --- | --- | --- |
| FADE-MVP — standalone terminal experiment from the human's build brief | passed | Strict TypeScript checks and production build exit 0; 14 automated tests pass; real Pi/OpenCode Go DeepSeek V4.1 Flash A → B transition passes; six generated notebook tests independently pass. |
| FADE-INSTALL — consistent naming and global terminal command | passed | Folder renamed to Fade; npm global link installed; Fade --help and launch/quit from an unrelated directory exit 0; current directory becomes the workspace; strict TypeScript, production build and all 14 tests pass. |
| FADE-TUI — Pi's native interface with Fade's automatic loop | passed | Strict TypeScript and production build exit 0; all 18 automated tests pass; global Fade launches Pi InteractiveMode branded Fade; native theme, editor/history, settings, model picker, confirmation dialog, recovery and quit exercised in a Windows PTY. Model choice follows Pi configuration and explicit overrides; no preferred model is hardcoded. |
| FADE-PI-ENGINE — Pi 1.0 tools, native conversation, Builder communication and readable reports | passed | Strict TypeScript and build exit 0; 26 deterministic tests pass; actual cloud file read and native shell pass; real Builder A → B passes; two three-exchange cloud runs pass with Builder steering receipts and readable reports; global Fade native PTY read/shell/new/recovery/report/log/quit pass; production npm audit reports zero findings. |

Earlier verification: 2026-10-10 (Asia/Shanghai), Node 24.14.1, Windows, Pi SDK 0.73.1. Existing parent repository files and statuses were preserved.

## Exact checks

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json` — exit 0, including app, tests and live smoke script.
- `node --import tsx --test tests/*.test.ts` — exit 0, 14 passed, 0 failed/skipped. Includes actual terminal startup/recovery/writing mode/exit.
- `node node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0, usable `dist/cli.js` produced.
- `node dist/cli.js --help` — exit 0, terminal commands displayed.
- `node --import tsx scripts/live-smoke.ts` — exit 0, both roles used `opencode-go/deepseek-v4.1-flash`. Actual Pi wrote notebook files, the Companion recorded five source-backed intent entries during implementation, and the Builder automatically completed the next search slice. Pi session references were separate; two Builder sessions were recorded.
- Independent `node --check <live workspace>/notebook.mjs` — exit 0.
- Independent `node <live workspace>/notebook.test.mjs` — exit 0; six real generated tests passed.
- `npm audit --omit=dev --json` — exit 1, eight high-severity findings in the requested legacy Pi package/dependency tree. These upstream advisories are unresolved; see README limits.

## Live evidence

Local evidence remains at `C:\Users\LENOVO\AppData\Local\Temp\fade-live-DhSN3U`; generated projects, raw model sessions and conversations are not published to GitHub. First actual Pi file-write event: 2026-10-10T07:13:11.903Z. Companion reply recorded: 2026-10-10T07:13:12.660Z, while the foundation was still running. Completed slices: “Notebook foundation” and “Case-insensitive note search.”

Earlier exploratory tests exposed malformed output from a local model and an OpenCode Go request missing its session-routing header. The user then requested cloud-only testing. The recorded live test explicitly used DeepSeek V4.1 Flash. Fade uses Pi's model selection without a hardcoded preference, supplies Go's required session header when applicable, and makes one bounded tool-less formatting repair when JSON is invalid. The live smoke script now requires explicit model selectors.

## Historical MVP limitations (superseded by the current section)

No blocker remains for the terminal MVP. Companion interpretation still needs human use to assess its quality; quoted evidence does not guarantee semantic fidelity. The Companion buffers structured replies rather than streaming prose. Shell execution is trusted local execution, not an OS sandbox. The deprecated requested SDK has unresolved upstream advisories. No web UI, cloud sync, alternate coding harness, or production deployment was added.

## Terminal installation

The source folder is `C:\Users\LENOVO\Documents\ChatGPT\Apple-of-my-ai\Fade`. `npm link --ignore-scripts --no-audit --no-fund` installed the `Fade` command into the existing npm global bin directory on PATH. `Get-Command Fade` resolves its PowerShell, cmd and shell shims. `Fade --help` ran from the user home directory; piping `/quit` into `Fade` from a fresh temporary directory opened that directory as the workspace and removed its lock on exit. No environment PATH edits were needed. Current source, documentation and built output contain no retired folder-name references.

## Native TUI verification

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json` — exit 0 after the TUI and model-selection correction.
- `node --import tsx --test tests/*.test.ts` — exit 0, 18 passed, 0 failed/skipped. The real Pi SDK consumes regular input before its model loop; Fade starts separate concurrent roles, saves rapid submissions immediately, preserves queued thoughts on quit, restores native display history, follows configured Pi model selection, and retains an explicit Builder override.
- `node node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0; the already-installed global command uses the rebuilt output.
- `git diff --check` — exit 0.
- `Fade --workspace <temporary workspace>` — actual Windows PTY launch with Fade header/title, existing Pi theme, native editor and footer. Normal input produced a real cloud Companion response while the Builder wrote files. This run used DeepSeek V4.1 Flash as a test model before the preference was removed. Restart restored the conversation paused; native `/settings`, prompt recall, `/model`, command confirmation and `/quit` were exercised. The final launch inherited the user's existing Pi selection without making a model call.
- Independent `node test.mjs`, `node --check index.mjs`, and `node index.mjs` in `C:\Users\LENOVO\AppData\Local\Temp\fade-native-ui-check` — exit 0. The generated command prints a nonempty sentence. Its verification helper remains after its nonroutine deletion request was denied.
- `node --import tsx scripts/live-smoke.ts` without explicit model environment variables — expected exit 1 before creating a workspace or calling a model. The script requires the tester to select both role models.

Pi's presentation session is reconstructed from Fade's durable conversation; it does not run a model or execute code. Structured Companion responses remain buffered before prose rendering. The line interface is retained for piped input and explicit `--plain` use. No blocker remains for this TUI change.

## Current Pi engine and communication verification

Verified 2026-10-10, Windows, Node 24.14.1, Pi 1.0.4. The earlier presentation-only session, tool-less Companion, resource exclusions, blocked session controls, shell gate, and buffered native reply architecture have been replaced.

Files changed: `package.json`, `package-lock.json`, `src/app.ts`, `src/cli.ts`, `src/contracts.ts`, `src/coordinator.ts`, `src/pi.ts`, `src/pi-resources.ts`, `src/plain.ts`, `src/prompts.ts`, `src/reports.ts`, `src/tui.ts`, `src/workspace.ts`, `tests/coordinator.test.ts`, `tests/tui.test.ts`, `scripts/live-native.ts`, `scripts/live-exchanges.ts`, `README.md`, `AGENTS.md`, and this status file.

- `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json` — exit 0.
- `node --import tsx --test tests/*.test.ts` — exit 0, 26 passed, zero failed/skipped. New coverage uses the real Pi loop with simulated model transport and actual file tools. Covers Builder note durability, queue vs receipt, concurrent intent replacement, interruption/recovery, late delivery and shutdown races, invalid evidence, and readable tool failures.
- `node node_modules/typescript/bin/tsc -p tsconfig.json` — exit 0; global Fade's linked executable uses this build.
- `node --import tsx scripts/live-native.ts` — exit 0, explicitly selected `opencode-go/deepseek-v4.1-flash` for both roles. The Companion used bash/read, returned a random marker known only from essay.md, and native shell execution passed. Workspace: `C:\Users\LENOVO\AppData\Local\Temp\fade-native-tools-xOmD22`.
- `node --import tsx scripts/live-smoke.ts` — exit 0 after the Pi upgrade, with the same explicit cloud test selection. Actual Builder foundation → search transition completed. Independent `node notebook.mjs.test.mjs` and `node --check notebook.mjs` exited 0 in `C:\Users\LENOVO\AppData\Local\Temp\fade-live-Wr3Dou`.
- `node --import tsx scripts/live-exchanges.ts` — exit 0 in two real cloud runs: `fade-exchanges-5PCSWd` and, after the final role-service integration, `fade-exchanges-aidKDF`. Each ran three actual Companion exchanges: inspect writing, compare rewrites without changing the essay, and explain completed Builder work. A separately addressed Builder note was delivered through Pi steering and durably marked received. `/reports` reached the real native transcript. The Companion independently read the generated module and reran its checks. Independent generated test execution passed: five Node tests in the first run, nine assertions in the final run.
- `Fade --workspace <temporary directory>` — real Windows PTY shows Pi 1.0.4 InteractiveMode with the compact Fade header, native streamed prose/tool output and counters. Existing user extensions and skills loaded. Ordinary file inspection, `!echo`, `/new`, restart/recovery, `/builder`, a saved pending Builder note, `/reports`, readable `/log`, and `/quit` were exercised. Workspace locks were removed on exit.
- `npm audit --omit=dev --json` — exit 0, zero reported vulnerabilities, replacing the earlier legacy dependency findings.
- `git diff --check` — exit 0.

No implementation blocker remains. Ordinary conversation uses the real Pi Companion session and default model selection; no provider/model preference is hardcoded. Builder notes are saved before transport and distinguish pending, queued, and received. Received means inclusion in the Builder's Pi context, not proof that it followed the note. Scope changes remain explicit. Reports attribute model verification claims and expose actual tool results. Pi tools have normal local permissions; concurrency boundaries are instructions rather than filesystem isolation. The complete CLI built-in extension set uses a validated internal manifest from the pinned SDK. Some stock Pi auxiliary text, including its native exit resume hint, still identifies Pi; launch `Fade` in the workspace to resume the integrated loop.
