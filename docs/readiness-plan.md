# Fade 1.0 production readiness — copy-ready agent prompt

## 1. Mission, evidence and release standard

You are responsible for making **Fade genuinely ready for everyday use and a public Reddit launch**. Fix the underlying behavior, complete the missing interactions, and prove the final installable product works. Passing unit tests or improving the welcome screen is insufficient.

The human has selected these constraints:

- Preserve **Builder, Companion and Fade modes**, with two Pi roles and one coordinator.
- Keep **Pi as the engine**. Redesign Fade’s terminal shell and integration where necessary.
- Qualify **Windows, macOS and Linux** before claiming production support.
- Qualify **a cloud provider and a local OpenAI-compatible endpoint**.
- Prepare npm distribution as **`@muzaffermahi/fade`**, preserving the **`Fade`** executable, plus a verified GitHub archive.
- Preserve the parent Veto project, mini project, unrelated experiments and existing changes.
- Work through bounded work orders sequentially.
- Do not commit, push, publish packages, create public releases or post to Reddit without separate human authorization.

The approved product remains: **think about software’s future with Companion while Builder implements its settled present**. Companion remains read-only. Builder retains stock Pi implementation tools. Fade coordinates execution; it is not an OS sandbox.

### What the planning audit actually established

On the inspected working tree:

| Check | Result |
|---|---|
| Strict source/test TypeScript | Passed |
| Existing deterministic suite | **70 passed, zero failed or skipped** |
| Production dependency audit | **Zero current advisories** |
| `git diff --check` | Passed; line-ending warnings only |
| Real Pi renderer with synthetic transport | Used for targeted interaction probes |
| Real-provider qualification during this audit | Not performed |
| Physical terminal/IME qualification during this audit | Not performed |
| Clean macOS/Linux installation during this audit | Not performed |

The audit also reproduced failures that those 70 tests do not catch. Therefore, existing “passed” implementation entries are historical evidence, not blanket proof that the current product is production-ready.

The primary integration locations are:

- [Fade’s split workspace renderer](C:/Users/LENOVO/Documents/ChatGPT/Apple-of-my-ai/Fade/src/workspace-ui.ts)
- [Fade’s Pi integration](C:/Users/LENOVO/Documents/ChatGPT/Apple-of-my-ai/Fade/src/tui.ts)
- [Fade’s application command layer](C:/Users/LENOVO/Documents/ChatGPT/Apple-of-my-ai/Fade/src/app.ts)

### Reference implementations inspected

Use references for specific patterns, not feature copying:

| Reference | Pattern to study |
|---|---|
| [Pi 1.0.4 InteractiveMode](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/modes/interactive/interactive-mode.ts) | Autocomplete installation, native editor behavior, command handling, dialogs, working indicators and restoration |
| [Pi editor](https://github.com/earendil-works/pi/blob/main/packages/tui/src/components/editor.ts) | Completion rendering, cursor placement, multiline editing and input ownership |
| [Nanocoder UserInput](https://github.com/Nano-Collective/nanocoder/blob/main/source/components/user-input.tsx) | Immediate `/` suggestions, completion dismissal, history interaction, preservation of command arguments and queued drafts |
| [Nanocoder command parser](https://github.com/Nano-Collective/nanocoder/blob/main/source/command-parser.ts) | Separating commands, ordinary text, shell syntax and path-like input |
| [Nanocoder command progress](https://github.com/Nano-Collective/nanocoder/blob/main/source/components/command-progress.tsx) | Explicit feedback while a slow command executes |
| [Nanocoder cancellation indicator](https://github.com/Nano-Collective/nanocoder/blob/main/source/components/cancelling-indicator.tsx) | Showing cancellation as an operation in progress |

**Compatibility must be checked against the installed Pi 1.0.4 types and implementation.** GitHub main may have different APIs.

A useful discovery: Pi exposes `ExtensionUIContext.addAutocompleteProvider(...)`. Fade can obtain the current provider through that public wrapper hook and install compatible behavior in its role editors. Also, `pi.getCommands()` in the pinned implementation supplies extensions, templates and skills; it does **not** enumerate every native InteractiveMode command. Do not mistakenly build an incomplete command catalog from that method alone.

---

## 2. Gap inventory

Use the following labels:

- **R — reproduced:** observed in a targeted runtime probe.
- **C — code-confirmed:** directly present in the inspected implementation.
- **Q — qualification required:** a concrete risk or unproven release claim; investigate before calling it a defect.

Every item needs a disposition: fixed, verified already correct, intentionally supported differently with documentation, or blocked by a named missing external condition. “Probably fine” is not a disposition.

### A. Commands, editing and navigation

| ID | Evidence | Gap and required outcome |
|---|---|---|
| G01 | R | Typing `/` in a split editor produces no autocomplete. Both role composers must show available commands immediately. |
| G02 | C | Split editors never receive Pi’s autocomplete provider. Reuse the public provider integration rather than building a disconnected list. |
| G03 | C | Editor output is cut into a maximum four-row body. Pi appends completion rows after its editor borders, so adding a provider alone will still clip menus. Give completions a separate, measured layout region. |
| G04 | C | Tab is intercepted for pane switching before the editor sees it. Completion must take precedence while a picker is open. |
| G05 | R | An unknown slash command leaves Fade and becomes accepted model input. Unknown commands must fail locally and invoke no provider. |
| G06 | C | A hardcoded slash-command regex disagrees with registered commands. Commands such as `/preference` and `/apply-intent` follow a different route. Replace duplicate command lists with one catalog and dispatcher. |
| G07 | R | `/preference technical` works but unexpectedly exits the split workspace. Ordinary Fade controls should preserve the current surface. |
| G08 | R | A command’s native response can exist while its result is invisible in Fade. Every invocation needs a visible result, error or pending state. |
| G09 | C | Split editors bypass the native integration that copies app action handlers and extension shortcuts. Inventory and restore supported shortcuts, including exit, model selection, external editing and queue actions. |
| G10 | C | Ctrl+C always forwards `/quit`; Ctrl+D has no split-editor handler. Define, implement and test consistent cancellation and exit behavior. |
| G11 | C | Parsing checks the raw string for `/` and `!`. Leading whitespace and pasted command input can take different paths. Parse once, preserving the original text and arguments. |
| G12 | C | Plain and interactive commands, help and aliases disagree. `/resume` means Builder continuation in plain mode but native session selection in the TUI. Eliminate silent semantic ambiguity. |
| G13 | C | Native handoff restores the root and immediately injects Enter. It lacks an explicit control lifecycle for completion, cancellation and return. Make handoff an owned operation with deterministic restoration. |
| G14 | C | Attachment handling inserts a textual marker but has no visible attachment tray or removal operation. Deleting the marker must not leave an invisible attachment waiting to be sent. |
| G15 | C | Clipboard MIME detection treats anything other than a JPEG-like first byte as PNG. Validate supported image signatures and show actionable errors. |
| G16 | C | Drafts allow 200,000 characters while accepted text is limited to 20,000. Communicate the send limit before submission and preserve oversized drafts. |
| G17 | Q | File mentions, prompt templates, skills, custom commands, argument completion and extension shortcuts lack a complete split-view qualification matrix. Test every advertised capability. |

### B. Activity, errors and outcomes

| ID | Evidence | Gap and required outcome |
|---|---|---|
| G18 | C | Companion’s pane subtitle is permanently “Thinking about what’s next.” It does not distinguish ready, preparing, requesting, streaming, inspecting, queued, failed or cancelled. |
| G19 | C | The shared projection principally describes Builder work. A Companion request before Builder starts can look idle. Show activity independently for both roles. |
| G20 | C | Native status and notification components sit in roots removed from the visible tree. Route required feedback into Fade’s visible projection. |
| G21 | R | A provider failure produces a failed receipt, but the actual error text is absent from Fade. Show the failure, affected input and available recovery actions immediately. |
| G22 | C | Builder’s split transcript shows recent tool starts and ends, but excludes tool updates. Long-running shell output can appear frozen. Display bounded live output. |
| G23 | C | Builder prose updates are not forwarded as live activity. Distinguish waiting for the model from executing a tool; retain final structured reporting. |
| G24 | C | Tool lines show only the first formatted line. Users cannot readily see a command, target, output, duration and outcome together. Provide compact expandable operation cards. |
| G25 | C | Split view omits projected run allowance and usage information that the native work strip exposes. Make relevant limits discoverable during work. |
| G26 | C | Builder pane phase comes from the last global work event and can remain stale after completion. Derive phase from the current operation. |
| G27 | C | Authentication readiness is captured during runtime creation and passed into the workspace as a fixed value. Refresh after login, logout and model changes. |
| G28 | C | There is no visible slow-provider, retry, compaction or cancellation lifecycle in the split projection. Add truthful states and elapsed time. |
| G29 | C | Completed outcome cards are sent to the native transcript, while split view reconstructs simpler slice summaries. Present one consistent outcome with changes, evidence, limits and next state. |
| G30 | C | Historical blocked slices and failed receipts can dominate “Needs you” after they cease to be actionable. Derive attention from current unresolved conditions. |

### C. Sessions, authority, persistence and verification

| ID | Evidence | Gap and required outcome |
|---|---|---|
| G31 | R/C | Old conversation remains in application history after a session switch; split transcript and shared discussion do not filter by session. Prevent accidental cross-session transcript and context leakage. |
| G32 | C | Assistant conversation records have a target role but no session identity. Introduce explicit session association with a conservative migration. |
| G33 | C | Native queued inputs are matched using text and mode. Identical messages can be ambiguous. Track submission identity through transport consumption. |
| G34 | R | A Builder can return `completed` with zero observed tool results and fabricated verification strings; the slice becomes completed. Separate implementation outcome from verified acceptance, and gate dependent work appropriately. |
| G35 | C | Failure tracking resolves by exact shell command, but completion does not establish that required acceptance checks actually ran. Track required checks explicitly. |
| G36 | R | A Windows `.fade` junction sends coordinator lock writes outside the workspace. Validate the canonical state directory and protected descendants before access. |
| G37 | C | Full project state is serialized and fsynced repeatedly; history, work events and attachment data stay in growing arrays. Checkpoint rotation does not bound the size of the latest state. Establish a long-session storage and latency budget. |
| G38 | C | Every editor change synchronously rewrites terminal state, including attachment data. Move large payloads out of frequent draft saves and coalesce best-effort draft persistence. |
| G39 | C | Split transcript retains only the last 60 messages, and several inspections show only recent records. Older history needs accessible paging or search. |
| G40 | C | Snapshots exclude large files, binaries and symlinks; the diff replaces whole file contents. Preserve the honest limitations and improve review readability. |
| G41 | Q | Stock Builder tools can access `.fade` or external paths despite prompt instructions. Document this trusted-execution boundary accurately; detect coordinator-state integrity problems without claiming a sandbox or replacing stock tools with forbidden restrictive wrappers. |
| G42 | Q | Storage failures, late stream events, session changes and shutdown need stress tests through the actual split UI. Existing domain tests do not prove every UI path retains role, attachments and receipts. |
| G43 | Q | Terminal escape sequences, OSC links, clipboard sequences, bidi controls and hostile tool output require consistent rendering protection. Current sanitizers differ between surfaces. |
| G44 | Q | Cancellation must actually stop provider work and supported tool processes. Showing “cancelled” before the operation quiesces is unacceptable. |

### D. Presentation, compatibility and distribution

| ID | Evidence | Gap and required outcome |
|---|---|---|
| G45 | C | Split colors are mostly hardcoded, with only partial light/dark handling. Honor Pi themes, `NO_COLOR` and readable focus/error states. |
| G46 | C/Q | Narrow layout depends on several minimum heights and final clipping. Prove that commands, focused input, actionable failures and status remain reachable at small sizes. |
| G47 | C | The package is private `1.0.0-rc.1`, and tests require that private prerelease state. Update release checks to validate the appropriate candidate or stable manifest. |
| G48 | R | npm’s unscoped `fade` name belongs to an unrelated package. Use `@muzaffermahi/fade`; verify ownership before publication. Never advertise `npm install -g fade`. |
| G49 | C | Packaging and smoke helpers hardcode `node_modules/fade` and uninstall `fade`. Make them derive package identity from the staged manifest. |
| G50 | C | The package inventory includes entire source/script directories, including experiments and debug helpers. Preserve those locally while defining an intentional public runtime/source inventory. |
| G51 | C | The upgrade smoke reinstalls the same candidate. Test a real previous-version-to-new-version upgrade and migration. |
| G52 | C | The configured CI matrix has not supplied recorded qualification results. Valid YAML and existing action tags do not prove the workflow passes. |
| G53 | C | Windows development linking and local rehearsals do not establish clean-machine installation. Test the actual shipped archive and global command. |
| G54 | C | Existing clean-platform, physical terminal and unfamiliar-user release gates remain open. Complete them; do not relabel them as passed. |
| G55 | C | README/help/troubleshooting contain contradictory descriptions of default routing and Escape behavior. Generate command help from the catalog and rewrite workflow documentation around actual behavior. |
| G56 | Q | Local-model reliability, provider errors, context exhaustion, authentication expiry and endpoint failures need packaged qualification. Cloud-only historical tests do not establish local support. |
| G57 | Q | Public diagnostics, demo recordings, release archives and bug reports need secret/private-content checks. Produce synthetic examples and explicit user-controlled export. |
| G58 | Q | Startup, echo, rendering, memory and disk-growth targets need measurement against the final split UI under realistic history and concurrent streaming. |

This inventory is the starting point. Continue discovery through complete user journeys and fault testing; add newly found defects to the same register.

---

## 3. Required production behavior and architecture

### One command system

Introduce a typed command catalog shared by registration, dispatch, completion and help. Each command definition must contain:

- Name, description, aliases and argument guidance.
- Supported surfaces.
- Handler category: Fade operation, inspection, native control, template or skill.
- Whether it changes state or opens a dialog.
- Availability and disabled reason.
- Optional progress label and argument completion.

Keep command definitions independent of rendering.

Dispatch rules:

1. Recognized Fade commands invoke the shared application handler directly.
2. Recognized native controls use an explicit Pi handoff.
3. Templates and skills retain their intentional prompt-expansion behavior.
4. Unknown slash commands show a local error with suggestions and preserve the editable command.
5. Bare `/` opens the menu and makes no model call.
6. Ordinary text goes to the focused role.
7. `!` and `!!` remain explicit human shell operations through Pi, after Builder quiescence.
8. Multiline prose and code blocks containing slash-like text are not silently classified as commands.
9. Command arguments remain intact; completion must not discard them.
10. Every command completes with a visible result, error or acknowledged pending operation.

Use `/continue` for Builder continuation. Interactive `/resume` retains Pi’s session-selection meaning. Preserve the legacy plain `/resume` Builder alias for one compatibility cycle with an explicit deprecation message pointing to `/continue`. Document this intentional difference.

Add two narrowly useful controls:

- `/doctor`: local configuration, environment and recovery diagnostics without a provider call.
- `/bug-report`: preview and export a redacted diagnostic bundle without uploading it.

Do not invent a plugin system, workflow builder or third agent.

### Completion and keyboard ownership

Use Pi’s public autocomplete-provider hook and a small compatibility adapter. Reapply the provider when Pi reloads resources or changes session.

The menu must:

- Open when `/` is typed.
- Filter commands with descriptions.
- Show native controls, Fade commands and available resources accurately.
- Show disabled commands with reasons.
- Support Up/Down and visible paging.
- Use Tab to accept a completion while open.
- Use Enter according to Pi-compatible selection semantics.
- Execute an explicitly typed exact command with its arguments correctly.
- Close on Escape without interrupting work.
- Avoid reopening immediately after dismissal until input changes.
- Preserve history navigation when recalling previous commands.

Keyboard ownership order:

1. Active native dialog or overlay.
2. Completion picker.
3. Focused composer editing.
4. Fade pane/mode actions.
5. Global control actions.

Default Tab switches panes only when no completion picker owns it. Keep remapping support.

Escape closes a dialog or menu first; otherwise it interrupts the focused role. Builder interruption retains partial work and pauses continuation. Companion interruption leaves unrelated Builder work running.

Ctrl+C interrupts active work in the focused role; a subsequent Ctrl+C within one second exits. At idle, Ctrl+C exits. Ctrl+D with an empty composer exits; with content, it preserves native forward-delete behavior. All exit routes use the same orderly shutdown.

Native app shortcuts must either work through the adapter or visibly open the native surface. They must never silently disappear.

### An explicit UI integration boundary

Replace scattered root manipulation with one owned adapter responsible for:

- Mounting and unmounting Fade.
- Preserving both drafts, attachment trays, focus and reading position.
- Installing completion providers.
- Routing native controls.
- Tracking native dialog lifecycle.
- Restoring the workspace after finite native interactions.
- Disposing listeners and timers exactly once.
- Exposing visible notifications and command outcomes.

Use public Pi/TUI APIs. Do not access private transcript containers, patch dependencies or run a second terminal renderer.

`/pi` deliberately stays in the native surface until `/fade`. Known finite controls such as model/settings dialogs return to Fade after completion or cancellation. Session controls rebuild the workspace against the selected session. Unknown third-party controls may remain native with a visible `/fade` return instruction.

A handoff failure restores the previous drafts and reports the failed control. Do not forward a command before the native editor is ready.

### Honest activity and progress

Add a validated per-role activity projection with:

- Role, session and operation identity.
- Current state and phase.
- Start time and last received activity.
- Current tool/target/command.
- Queue count.
- Cancellation state.
- Error summary and available recovery actions.
- Usage and context information when actually available.

Required states include ready, preparing, waiting for provider, streaming, inspecting, executing, checking, queued, cancelling, paused, blocked, failed and completed.

Show:

- A compact spinner for indeterminate work.
- Elapsed time.
- The actual current operation.
- A “waiting for provider” or “no new activity” explanation when appropriate.
- Determinate progress only when a measurable total exists.
- Check counts such as “2 of 3 checks passed,” rather than invented model percentages.

Animate at approximately 100 ms while active. Re-render on received state changes with bounded batching; do not rely on a one-second timer to reveal new output.

After 15 seconds without activity, explain what is being awaited. After 60 seconds, offer interruption and diagnostics without claiming the request has failed. Retain a configurable provider-turn deadline, initially ten minutes. Surface provider retries and compaction; never silently replay uncertain operations.

The primary view must answer:

- What is Builder doing?
- What is Companion doing?
- Was my input saved?
- Is it queued or actually received?
- What needs my intervention?
- What happened when the operation ended?

### Visible errors and recoverable input

Use one typed notification model across split, native and plain surfaces.

Include the failed operation, role, receipt when applicable, concise cause and next action. Distinguish:

- Rejected before durable acceptance.
- Accepted but not delivered.
- Delivered with uncertain outcome.
- Provider failure.
- Tool failure.
- Storage failure.
- Unsupported capability.
- Invalid command.
- Intent conflict.
- Verification failure.

Unsaved input is restored to the correct composer with attachments. Durably accepted input remains accessible through its receipt and is not duplicated by automatic restoration or retry.

Never treat an error as an empty successful response. Never hide actionable failures solely in `/diagnostics`.

### Session and receipt integrity

Separate workspace-level project intent from session-level conversations.

Introduce explicit session identity on new conversation records and correlate assistant replies to their triggering receipt where available. Transcript and provider discussion use the current session. Workspace-level settled intent and active Builder work remain explicitly labelled as shared project state.

During migration:

- Preserve all old records.
- Associate records with a session only when provenance proves the association.
- Put ambiguous legacy records in labelled project history.
- Do not silently inject ambiguous history into a new session.
- Keep a backup and recover paused.

Native `/new` creates a new conversation session; it does not reset project intent or cancel Builder work. `/resume`, `/tree` and `/fork` preserve Pi semantics while refreshing session-specific UI state.

Replace text-based queue matching with identity-based correlation. Test repeated identical text, different roles, different modes and attachments.

Capture the destination role and session before asynchronous acceptance. Pane switches, dialogs and session navigation must not reroute already accepted input.

### Verification that means something

Keep model claims separate from observed evidence.

Introduce an acceptance-check record with:

- Check identity and criterion.
- Whether it is executable or requires human inspection.
- Observed execution references where available.
- Status: not run, running, passed, failed or needs human inspection.
- Evidence and latest result.

A slice’s implementation outcome and verification status are distinct.

Rules:

- Zero observed checks cannot produce “verified.”
- Missing required checks stay visible.
- Failed required checks block verified completion.
- A successful rerun resolves the same check while preserving the failed history.
- An unrelated success does not clear a failure.
- Manual acceptance is recorded as an explicit human action.
- Dependent automatic work waits for required executable checks to pass; required manual checks wait for human acceptance.
- Metadata-only tasks may complete without an implementation tool call, but cannot claim unobserved verification.

Do not execute model-supplied acceptance strings in a new coordinator shell. Builder performs checks through stock tools; the coordinator records and evaluates evidence.

Completion should show one compact outcome: what changed, observed checks, reported claims, remaining limits and next state. Do not collapse “tool exited successfully,” “implementation completed” and “requirements verified” into one green indicator.

### Persistence, storage and protected state

Introduce a versioned migration for new session, attachment and verification records. Preserve v1 and v2 provenance and receipts.

Protect coordinator-owned filesystem paths:

- Canonicalize the workspace and state directory.
- Reject a `.fade` symlink or junction that escapes the canonical workspace.
- Validate protected descendants and temporary files.
- Use unique exclusive temporary files for atomic replacement.
- Test replacement races and tampered state paths.
- Keep relocation an explicit backed-up operation.

Preserve durable acceptance before acknowledgment.

Move large attachments and raw operation payloads out of frequently rewritten state into validated content-addressed blobs or per-operation records. Keep hashes, sizes and references in the state index. Preserve and migrate existing inline payloads without loss.

For new image input, retain a maximum of 20 attachments, enforce 15 MiB per image and 30 MiB aggregate decoded size, and show the limit before acceptance. Validate supported PNG/JPEG/WebP signatures. Legacy payloads exceeding new send limits remain readable.

Coalesce best-effort draft saves with a maximum 150 ms delay. Flush on submission, role switch, native handoff, session change and orderly shutdown. Accepted receipts remain durably written immediately.

Bound in-memory history and projections through paging while retaining archived provenance. Avoid loading every conversation or raw tool result to render one screen.

Keep tool start/end and final verification records durable. Batch intermediate display updates without losing final output or pretending unflushed output was persisted.

Measure latency, memory and disk growth under long-session load before declaring the storage design complete.

### Terminal readability and accessibility

Preserve Fade’s recognizable mint/lavender/ivory identity and accepted wordmark. Prioritize readable work over decorative size.

Support:

- Pi themes and `NO_COLOR`.
- Clear focus labels beyond color.
- Textual success/failure/cancellation indicators.
- Unicode, CJK, combining characters and emoji.
- IME cursor placement.
- Bracketed paste and multiline editing.
- Stable scrolling during concurrent output.
- Visible “new output” indication while reading older content.
- Compact narrow layout.
- A readable plain fallback.

Reserve layout space before rendering headers, status, composers and menus. When the terminal is too small, show a compact explanation and usable focused input; do not silently clip critical actions.

Use a consistent sanitizer for untrusted model/tool text. Prevent terminal control execution while preserving ordinary Unicode and supported presentation. Raw private logs may retain original bytes; exported diagnostics must be redacted.

### Distribution and launch material

Prepare `@muzaffermahi/fade` with `Fade` and lowercase `fade` executable aliases. Test both on case-sensitive systems.

Derive installed paths, uninstall commands and package smoke behavior from the package manifest. Verify npm scope ownership before publishing.

Ship an intentional allowlist containing the runtime, required assets, license/notices and user documentation. Keep experiments and debug helpers locally; exclude them from the public runtime archive.

Build and verify the exact archive that will be published. Qualification records include its SHA-256. Changes to published bytes require affected checks to run again.

Provide:

- Clean install, first setup and first useful task.
- Cloud and local configuration.
- Upgrade, recovery and uninstall.
- Supported OS/terminal/Node/provider matrix.
- Troubleshooting with actionable errors.
- Privacy and trusted-execution explanation.
- Contribution and private security reporting.
- Synthetic example project and demo.
- Changelog and known limitations.
- A Reddit post draft that accurately describes the qualified product.

Do not upload conversations or diagnostics automatically. Do not claim local inference, sandboxing, universal provider support or verified completion beyond the evidence.

---

## 4. Ordered implementation work

Create these bounded work orders with Required reading, Owned paths, dependencies, baseline checks, acceptance criteria and verification commands. Execute **one at a time**.

F13–F24 are authorized readiness work following the completed foundational work and F09. They must not be blocked merely because the older F07/F08 external qualification is incomplete. Preserve those open gates and reconcile them during final qualification.

| Order | Deliverable | Completion evidence |
|---|---|---|
| **F13 — Readiness baseline and contracts** | Record the current tree, this gap register, approved product changes, compatibility rules and work-order sequence. Add failing regressions for reproduced defects. | Baseline commands recorded; regressions fail for their intended reasons; no unrelated changes. |
| **F14 — Command catalog and safe dispatch** | One command catalog, local unknown-command rejection, consistent argument parsing, generated help and explicit native/resource routes. | Every advertised command has a tested destination; bare `/` and typos make zero provider calls. |
| **F15 — Composer, completion and keyboard ownership** | Visible completion menus, provider wiring, argument/history behavior, native shortcut access and deterministic input ownership. | Actual split renderer tests for both roles, multiple sizes, Tab/Enter/Escape and remapped controls. |
| **F16 — Native control adapter** | Owned mount/handoff/return lifecycle with lossless drafts, attachments, focus and session refresh. | Login/model/settings/session/reload/dialog cancellation tests; no leaked listeners or duplicate roots. |
| **F17 — Activity, notifications and live output** | Per-role progress, visible provider/tool errors, receipt feedback, streaming output, cancellation state and consistent outcomes. | Slow, silent, failing and concurrent fixtures remain understandable and responsive. |
| **F18 — Session and receipt integrity** | Session-labelled conversation, conservative migration, identity-based queue correlation and deterministic role routing. | Repeated identical inputs, session switches and late responses preserve destination and provenance. |
| **F19 — Observed acceptance and completion** | Typed check evidence, missing-check states and safe dependency progression. | Fabricated success, no checks, failed checks, repaired checks and manual criteria behave correctly. |
| **F20 — Protected state and recovery** | Canonical state containment, safe atomic files, integrity detection and crash-window recovery. | Junction/symlink, torn write, full disk, permission failure and stale/live lock tests. |
| **F21 — Long-session storage and attachments** | Blob-backed payloads, bounded indices/history, coalesced drafts, attachment tray and resource budgets. | Migration preserves bytes; long-history and maximum-supported-payload tests meet latency and memory targets. |
| **F22 — Terminal layout and review** | Themes, narrow layouts, IME/Unicode behavior, stable scrolling, readable diffs and paginated inspection. | Screen-state assertions and inspected captures at required dimensions and states. |
| **F23 — Provider and cancellation resilience** | Cloud/local compatibility, visible retries/compaction, correct deadlines and actual quiescence on interruption. | Deterministic faults plus explicitly selected real-provider rehearsals. |
| **F24 — Public package and support material** | Scoped package, executable aliases, intentional inventory, real upgrade tests, doctor/bug-report and accurate docs/demo. | Isolated install/configure/run/upgrade/uninstall from the final archive; no private payloads shipped. |
| **F25 — Cross-platform release qualification** | Final artifact qualified on Windows/macOS/Linux, required terminals, Node versions and cloud/local providers. Complete F07/F08 evidence. | Recorded candidate hash, environment, commands, captures and outcomes; genuine unfamiliar-user results. |
| **F26 — Reddit launch handoff** | Final readiness report, release notes, install instructions, demo and Reddit drafts. | All gates accounted for; copy and claims match the qualified archive; publication awaits human authorization. |

For each order:

1. Read the active order and required documents completely.
2. Inspect every owned module.
3. Run the smallest relevant existing test before editing.
4. Add behavioral regressions for meaningful failures.
5. Implement within the authorized scope.
6. Run named tests and strict TypeScript.
7. Record exact results.
8. Mark only the completed row passed.
9. Continue to the next eligible order.

If a contract change is required, make it explicit in the authorized work order before implementation. Do not invent behavior silently.

Preserve all unrelated modifications. Do not reset the tree, delete experiments, rewrite Git history or opportunistically refactor unrelated modules.

---

## 5. Acceptance matrix, release gates and reporting

### Mandatory behavior tests

| Area | Required scenarios |
|---|---|
| Command discovery | `/`, partial prefix, exact command, unknown command, unavailable command, arguments, leading whitespace, pasted command and command history |
| Completion ownership | Up/Down, Tab, Enter, Escape, pane switching, resource reload and both role editors |
| Commands during work | Help/status/intent/changes while both roles are active; slow command progress; visible success and error |
| Native controls | Login/logout, model selection, explicit Builder override, thinking/settings/theme, new/resume/tree/fork, reload and `/pi` → `/fade` |
| Input durability | Rapid submissions, duplicate text, steering/follow-up, role switch immediately after Enter, acceptance rejection and transport rejection |
| Attachments | Add/remove, marker deletion, invalid MIME, unsupported vision model, limits, queue edit/cancel, session switch and restart |
| Activity | First request with no Builder; provider silence; Companion tool read; Builder tool stream; simultaneous roles; completion and cancellation |
| Recovery | Crash before/after acceptance, during stream, during tool execution, during checkpoint and during migration |
| Storage | Disk full, read-only directory, mirror failure, malformed state, junction/symlink escape, temporary-file collision, live/stale lock |
| Sessions | New session isolation, old session resume, ambiguous migrated history, late reply rejection and shared project intent labels |
| Authority | Exploration/negation/quotations do not authorize work; explicit request does; active brief remains immutable; conflict holds future work |
| Ownership | Companion writes/shell/unknown indirect tools denied; native human shell waits for Builder quiescence |
| Verification | No observed checks, fabricated claims, missing required check, failed check, same-check repair, unrelated success and manual acceptance |
| Rendering safety | ANSI/OSC/control injection, long filenames, hostile errors, bidi/control characters and Unicode |
| Terminal layout | 120×40, 80×24, 45×20, very short terminal, live resize, light/dark/custom theme and `NO_COLOR` |
| Reading position | Scrollback during streaming, width change, overlay return, new-output badge, oldest history and search |
| Shutdown | Escape, Ctrl+C, Ctrl+D, `/quit`, SIGTERM where supported, pending queues and active tool/provider cancellation |
| Distribution | Fresh archive install, executable aliases, missing Bash, unsupported Node, paths with spaces/Unicode, real upgrade and uninstall |
| Providers | Configured cloud provider and local endpoint; refused connection, 401/403, 429, 5xx, malformed stream, empty response and context exhaustion |
| Long sessions | At least 1,000 receipts, substantial tool history, attachments and concurrent streaming without unbounded render-state growth |

Use observable behavior assertions: command handler reached, provider invocation count, focused editor, visible screen content, durable receipt and final file state. Do not substitute substring checks on old accumulated terminal output for assertions about the current screen.

### Verification commands

Use direct Node entry points from the Fade project directory:

```text
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json
node --import tsx --test tests/*.test.ts
node node_modules/typescript/bin/tsc -p tsconfig.json
node dist/cli.js --help
node scripts/verify.mjs
node scripts/package-release.mjs
node scripts/package-smoke.mjs
node --import tsx scripts/performance.ts
git diff --check
```

Run focused tests during bounded changes. Run the full relevant suite before packaging and qualification. Update helper commands where package identity or new qualification cases require it.

Live scripts require explicitly selected role models. Record failures as well as successes. Never quietly change models until a test passes and report only the successful rerun.

### Performance gates

Measure the final split workspace, not only the native Pi surface:

- Warm usable startup: **≤2 seconds** on recorded reference hardware.
- Input echo: **p95 <50 ms**.
- Received activity visible: **≤250 ms**.
- Completion feedback: **≤250 ms** after results are available.
- Reading position and focus remain stable during concurrent updates.
- Memory reaches a bounded working set for paged history.
- Disk-growth results are recorded for the long-session fixture.
- Provider latency is measured separately.
- Physical IME behavior is tested separately from an in-memory terminal sink.

Keep raw measurements and environment details. Do not claim physical-terminal latency from synthetic rendering alone.

### Platform and user gates

Before production claims:

1. Run CI on Windows, macOS and Linux with supported Node 22 and Node 24 versions.
2. Rehearse clean installation using the actual final archive.
3. Exercise Windows Terminal, macOS Terminal and at least one Linux terminal; record additional tested terminals separately.
4. Complete physical Unicode/IME, paste, theme, resize, scrolling and streaming walkthroughs.
5. Demonstrate a real file change and observed verification while Companion continues discussing the future.
6. Demonstrate interruption, restart-paused recovery, explicit continuation and a real upgrade.
7. Qualify one cloud provider and one local OpenAI-compatible endpoint against the packaged candidate.
8. Recruit five unfamiliar developers using the final candidate; at least four complete the core journey without coaching.
9. Record zero data loss and zero unintended execution during qualification.

Missing external environments, npm ownership or user participants are real blockers. Continue independent engineering work, but do not fabricate those results or mark their gates passed.

### Reddit launch package

Prepare, without publishing:

- A concise product explanation.
- The verified npm installation command and archive fallback.
- Prerequisites and first-run instructions.
- A short synthetic demo showing:
  1. Installing and configuring Fade.
  2. Typing `/` and selecting a working command.
  3. Starting a bounded Builder task.
  4. Seeing live activity and actual tool output.
  5. Discussing future design with Companion concurrently.
  6. Inspecting changes and observed checks.
  7. Interrupting and recovering safely.
- Supported-platform/provider matrix.
- Honest privacy and execution boundaries.
- Known limitations.
- Bug-report and contribution links.
- Separate Reddit drafts suitable for a general developer audience and a local-model audience.

The demo must run against the qualified artifact. No fabricated progress, hidden failures, private conversations or untested claims.

### Final agent reporting

Maintain the gap register with evidence and acceptance-test references. Each finding must be closed with proof or remain explicitly open.

For each completed work order, report:

1. Work order completed.
2. Files changed.
3. Behavior implemented.
4. Verification commands and results.
5. Remaining blocker or none.

At the end, provide the candidate SHA-256, qualification matrix, unresolved blockers and prepared launch material.

**Do not call Fade production-ready until the final installable artifact passes the engineering, platform, provider and unfamiliar-user gates. Prepare the concrete release for review; leave publication and the Reddit post to the human’s final authorization.**
