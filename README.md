# Fade

**A tool for the mind.** Develop the future with a Companion while Builder implements settled work.

This is the private **1.0.0-rc.2** candidate of **@muzaffermahi/fade**. Both `Fade` and `fade` are executable aliases. Publication and production qualification remain pending. Full packaged cloud/local Builder runs, clean Windows/macOS/Linux environments, physical terminal/IME walkthroughs and unfamiliar-user results still need passing evidence.

## Install and start

Requires Node **22.19 or newer** and Bash; Git for Windows supplies Bash. Install the exact local archive whose SHA-256 you verified:

```text
npm install --global /absolute/path/muzaffermahi-fade-1.0.0-rc.2.tgz
Fade --help
Fade --workspace /path/to/project
```

The launch directory is the workspace. `--plain` selects the line interface; piped input uses it automatically. See [install and upgrade](docs/install.md) and [troubleshooting](docs/troubleshooting.md). The unscoped npm package `fade` is unrelated; do not install it as this product.

## Two roles, one workspace

Companion explores ideas, inspects files and develops a source-backed future brief. Builder implements a concrete human request with settled references and declared acceptance checks. Exploration starts no implementation. Active briefs remain fixed; `/redirect` explicitly stops and replaces a direction. One future slice waits for observed acceptance of its dependencies.

The focused composer captures recipient, session, mode and images before acceptance. During active work, Builder input is a durable steering/follow-up note: saved, queued and received are distinct. Received means inclusion in Pi context, not proof the note was followed. Companion stays read-only while implementation continues.

Fade uses Pi **1.0.4** editors, resources, model selection and native dialogs. Alt+1/2/3 selects Builder/Companion/Fade; Tab accepts an open completion or switches panes. At narrow widths the focused conversation is shown with shared Builder status. PageUp/PageDown scrolls the focused history; reading position survives updates, resizing and native dialog return. Ctrl+O expands observed tool cards; Ctrl+Alt+I opens attachment removal.

Escape closes an overlay/completion first, then interrupts the focused role. Ctrl+C interrupts busy focused work; a second within one second exits. At idle it exits. Empty Ctrl+D exits; with content it keeps forward-delete. Finite native dialogs return to saved panes. `/pi` stays native until `/fade`. Explicit human `!` shell operations stop Builder before execution; use `/fade` to restore the panes if still native.

Role drafts survive rejected input. New PNG/JPEG/WebP attachments support at most 20 images, 15 MiB each and 30 MiB decoded total. Text sends support 20,000 characters. Unsupported model/image combinations retain the draft for correction.

## Models and credentials

Reuse Pi's configured models and credentials; Fade has no preferred provider/model. Select with native `/model` and `/login`, or explicitly override:

```text
Fade --builder provider/model-id --companion provider/model-id
```

`FADE_BUILDER_MODEL` and `FADE_COMPANION_MODEL` are equivalent. Provider availability, model behavior and loaded local context limits require their own checks. Configured credentials do not establish reachability. `/doctor` performs local checks without contacting a provider.

## Controls

The following list is generated from the shared command catalog.

<!-- GENERATED_COMMANDS -->
```text
/builder [message] — Inspect Builder or send a durable note
/companion [message] — Talk to Companion explicitly
/intent — Inspect and edit Living Intent
/changes [slice-id] — Inspect observed workspace changes
/log [query] — Search and page observed execution output
/status — Inspect activity, limits and receipts
/inputs — Inspect durable input receipts
/reports — Inspect outcomes, claims and evidence
/history — Inspect saved conversation
/help — Search Fade commands and Pi capabilities
/pause — Pause Builder and retain partial work
/stop — Stop automatic Builder continuation
/accept-check <slice-id> <check-id> pass|fail <evidence> — Record a human inspection result
/continue — Continue paused Builder work
/redirect <direction> — Interrupt Builder and develop new direction
/rethink — Reconcile intent and implementation discoveries
/apply-intent — Import revision-checked intent edits
/preference design|technical — Set conversation preference
/retry-input <receipt-id> — Explicitly retry a saved receipt
/edit-input <receipt-id> <text> — Edit an undelivered receipt
/cancel-input <receipt-id> — Cancel an undelivered receipt
/diagnostics — Inspect routine resource/update diagnostics
/pi — Open native Pi controls; /fade returns
/fade — Return to Fade split workspace
/doctor — Inspect local readiness and recovery without a provider call
/bug-report [export [relative-path.json]] — Preview metadata or export a local file after Builder stops
/settings — Open Pi settings
/model <provider/model> — Select role conversation model
/tree — Navigate Pi session tree
/thinking <level> — Set thinking level
/scoped-models — Choose models for cycling
/export [path] — Export Pi session
/import <path> — Import and resume a Pi JSONL session
/share — Share Pi session via its native control
/bug <description> — Pi developer bug-report control
/copy — Copy last Pi response
/name <name> — Set Pi session name
/session — Inspect Pi session stats
/changelog — Inspect Pi changelog
/hotkeys — Inspect native shortcuts
/fork — Fork a Pi session
/clone — Duplicate current Pi session
/trust — Set Pi project trust
/login [provider] — Configure provider authentication
/logout — Remove provider authentication
/new — Start a conversation session
/compact [instructions] — Compact Pi context
/resume — Select a Pi conversation session
/reload — Reload Pi resources
/quit — Save and exit Fade
Tab switches panes when no completion is open. Alt+1/2/3 selects Builder/Companion/Fade.
Escape closes inspection/completion first, otherwise interrupts the focused role. Companion stays read-only.
! / !! are explicit human shell operations through Pi after Builder quiescence.
/pi opens native controls; /fade restores saved panes.
```
<!-- END_GENERATED_COMMANDS -->

Interactive `/resume` selects a Pi conversation; `/continue` continues Builder. Plain `/resume` is a deprecated Builder alias for one compatibility cycle. Interactive `/reload` reloads Pi resources; plain `/reload` is a deprecated `/apply-intent` alias.

## Evidence, recovery and local support

Observed paired tool results and explicit human acceptance are separate from model verification claims. Zero observed checks cannot establish acceptance; failures and stale evidence hold dependent work. `/builder`, `/changes` and `/log` expose the evidence and its limits. Text snapshots omit binaries, links and large files; context diffs explicitly label omissions and uncertain external attribution. They never overwrite your files.

Accepted receipts are durably recorded before acknowledgement. Large payloads use separate files; older history remains paged/searchable. Draft writes coalesce for at most 150 ms and flush at boundaries. Recovery and backed-up migration stay paused; inspect `/inputs` and `/status` before an explicit retry or `/continue`.

`/bug-report` previews content-free support metadata. `/bug-report export [relative-path.json]` explicitly creates a new local file below the workspace root after Builder stops; existing files are never overwritten. The report excludes paths, IDs, URLs, credentials, errors, drafts, conversations, source and tool output. Native previews/exports never enter model context. Nothing is uploaded.

Stock Builder tools execute with your OS permissions. The coordinator's lease controls role overlap; it is not an OS sandbox against external programs or installed extension code. See [security reporting](SECURITY.md).

## Development and qualification

In a repository checkout:

```text
npm ci
node scripts/verify.mjs
node scripts/package-release.mjs
node scripts/package-smoke.mjs
node --import tsx scripts/performance.ts
```

The public archive has an explicit product source/runtime inventory; experiments, debug helpers, tests, work orders and private workspaces remain outside it. The smoke helper installs the unchanged previous archive with its own locked tree, then upgrades its preserved workspace using the scoped candidate in an isolated global prefix. It executes both aliases, verifies paused migration, and uninstalls without deleting project history or changing your global development link. Coupled Pi packages are explicit exact 1.0.4 dependencies; global npm installs cannot rely on a dependency package's overrides.

The deterministic suite uses real Pi loops/tools and synthetic transports. Real-provider rehearsals require explicit model selection and retain failures. Local rehearsals are not clean-machine or participant qualification. [Synthetic usage example](examples/conversation.md), [synthetic test-screen sequence](examples/demo.cast), [contributing](CONTRIBUTING.md) and [changelog](CHANGELOG.md). The demo is an anonymized sequence of actual test renders, not a physical-terminal/provider recording.
