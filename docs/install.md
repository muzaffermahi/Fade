# Install, upgrade and uninstall the private candidate

The package identity is **@muzaffermahi/fade**; both **Fade** and **fade** commands point to the same CLI. Version **1.0.0-rc.2** is private and unpublished. Scope ownership and release qualification must be verified before any publication. The unscoped npm package fade is unrelated.

Requires Node >=22.19 and Bash. Git for Windows supplies Bash. A UTF-8 terminal is recommended; --plain supports pipes/basic terminals. The archive carries npm-shrinkwrap.json for locked-root installs. Coupled Pi packages also have explicit exact 1.0.4 production pins because fresh global npm installs ignore a dependency package's overrides. Installation needs registry access; qualification records the installed environment as well as the archive hash.

## Exact archive

From a repository checkout, run node scripts/verify.mjs, node scripts/package-release.mjs and node scripts/package-smoke.mjs. releases/candidate.json records the archive, SHA-256, public inventory and actual previous archive/hash. Packaging rejects missing or mismatched prior evidence.

Compare the sidecar with Get-FileHash on Windows, shasum -a 256 on macOS, or sha256sum on Linux. Then substitute the verified absolute archive path:

```text
npm install --global /absolute/path/muzaffermahi-fade-1.0.0-rc.2.tgz
Fade --help
fade --help
Fade --workspace /path/to/project
```

On Windows an absolute C:\\path\\to\\archive.tgz works. npm creates .cmd/PowerShell shims; if PowerShell policy blocks them, run Fade.cmd. Add the existing npm global bin directory to PATH if necessary. Direct fallback: node <global-node_modules>/@muzaffermahi/fade/dist/cli.js; npm root --global identifies that directory.

## Configure

Use Pi's native /model and /login or its existing models.json/credentials. Role overrides are --builder provider/model and --companion provider/model, or FADE_BUILDER_MODEL/FADE_COMPANION_MODEL. /doctor reports local selection/authentication presence, Node/Bash and retained work without a provider request. For a local endpoint, match models.json contextWindow to the model's actually loaded context; a larger catalog value does not enlarge the server's context.

The default run limit is four; --run-limit 1..20 or FADE_RUN_LIMIT changes it. No provider/model is hardcoded. Finite native dialogs return to saved panes; /pi remains native until /fade.

## Real upgrade

Back up the project's .fade directory while Fade is closed. Install the newer verified archive; do not run two Fade instances against the same workspace. Migration preserves backed-up provenance and recovery stays paused. Inspect /inputs and /status before /continue; uncertain receipts require an explicit /retry-input.

Historical private candidates used an unscoped local name. Check npm ls --global --depth=0 and verify it is that private Fade candidate before removing its old install/link. Do not remove an unrelated package merely because its name is fade. Register the scoped replacement after the old private alias is removed. The smoke installs unchanged rc.1 archive bytes with npm ci in their extracted root, then upgrades the same workspace through an isolated scoped global rc.2 install. Fresh global rc.1 installation currently fails on unpinned transitive versions; that failed result is preserved rather than represented as passing.

## Uninstall

```text
npm uninstall --global @muzaffermahi/fade
```

Project files, .fade history, exported reports and shared Pi credentials remain. The smoke helper confirms this. Deleting those is a separate human action.

Recorded Windows/Node24 smoke is a local rehearsal. Clean Windows/macOS/Linux, Node22/24, physical terminal/IME, final packaged cloud/local providers and unfamiliar users remain release gates until actual results exist.

