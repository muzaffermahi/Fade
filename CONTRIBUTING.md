# Contributing to Fade

Fade is an independent terminal project. Keep changes inside this folder and preserve the parent Veto project. Read AGENTS.md and the active work order before editing. Work on one bounded order at a time; preserve user changes and experiments. Git history belongs to the human.

Requires Node >=22.19 and Bash (Git for Windows supplies it). In a repository checkout run npm ci, then the direct Node checks in README.md. All source, including preserved experiments, must typecheck. The public archive deliberately contains product source/runtime rather than development tests, work orders or debug helpers. Tests use real Pi loops/tools with simulated model transport. Avoid live provider calls unless explicitly selected and requested; live scripts run generated code in fresh temporary workspaces and retain failed results.

Use strict TypeScript, validated transport data and observed evidence. Companion ideas cannot authorize implementation. Preserve immutable active briefs, input provenance and session destinations. Never claim a model's report proves verification. Unknown tools are conservatively mutating during concurrent work.

Before review: run node scripts/verify.mjs, node scripts/license-notices.mjs, node scripts/package-release.mjs and node scripts/package-smoke.mjs. Describe the problem, resulting behavior, commands and actual results, plus limitations. Do not include credentials, private conversations, generated workspaces or terminal captures containing private data. Inspect the package inventory in releases/candidate.json. Release gates are in docs/release-checklist.md. Do not label 1.0 qualified without participant and platform evidence.

Package identity is @muzaffermahi/fade with Fade/fade aliases. Packaging validates an exact public allowlist and a real previous archive/hash. The smoke installs the actual previous archive's locked tree, upgrades its workspace through a fresh scoped global candidate, preserves provenance and leaves the developer's global link alone. Coupled Pi packages are exact direct production pins; dependency-package overrides cannot protect a global consumer. Scope ownership, final cloud/local Builder support, clean platforms, physical terminals/IME and unfamiliar-user qualification remain explicit gates.

No commit, push, package publication or public release is implied by local implementation. A release candidate remains private until the human authorizes publication.
