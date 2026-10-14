# Fade implementation contract

This independent project was authorized by the human's new build brief. Its product name, folder, terminal command, and public GitHub repository are **Fade**. The older parent project's v0.2 work orders and serialized contracts do not define this new experiment. Preserve all parent files.

Fade is a tool for the mind. The Builder implements the present; the Companion helps the human develop the future. The selected 2026-10-11 split-workspace brief supersedes the earlier single-conversation and Companion execution handoff requirements. F09 implements this human-selected change before further release qualification.

- Keep the implementation small: two Pi roles and the coordinator.
- The human-selected Fade 1.0 contract is `docs/product-contract.md`; release gates are in `docs/release-checklist.md`. Work through `work-orders/F01.md` onward one at a time, reading required documents, inspecting owned paths, checking dependencies and running the smallest relevant existing test before editing. Record only completed rows as passed. Preserve unrelated changes and both untracked experiments.
- Interactive `Fade` uses Pi's real InteractiveMode, branded Fade. Every ordinary prompt must enter Fade's loop automatically. Preserve Pi's editor, themes, keybindings, and native dialogs; the native Pi session is the actual Companion, integrated with Fade, not a presentation-only session.
- Retain native Pi editing, authentication/model selection, resources and session controls. Companion exposes only known read-only tools and validated coordinator metadata interfaces; writes, shell and unknown extension/MCP operations are denied. Builder retains implementation tools. Native shell is a human operation, never Companion authority.
- Future slices use settled, evidence-backed intent. Preserve tentative thoughts and conflicts visibly.
- The active Builder brief is immutable. Redirection must be explicit.
- Builder communication uses Pi steering with durable pending/queued/received receipts; never claim delivery from queueing alone. Reports include reported verification and actual readable tool logs. Preserve event logs and decision provenance. Model verification strings are claims, not proof.
- Use strict TypeScript and validated external payloads. Do not bypass contracts with casts or `any`.
- Use stock Pi tools and permissions. Builder scope is supplied in its immutable brief; do not replace native tools with a restrictive wrapper or command gate. Keep Fade state owned by the coordinator. Shell execution is trusted local execution, not a security sandbox.
- The coordinator owns workspace execution. During Builder work Companion remains read-only. Explicit human native shell execution first quiesces Builder and leaves its partial work saved; the execution lease never grants Companion mutation authority. Unknown extension/MCP operations are denied; annotations alone cannot prove read-only behavior. Preserve stock Builder tools. External program edits are outside this coordination boundary.
- Reuse Pi's configured model and credentials. Do not hardcode a preferred provider or model. Explicit role overrides remain available; cloud test models are selected explicitly for each test run. Never commit credentials, conversation state, or generated workspaces.
- Run `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json` and `node --import tsx --test tests/*.test.ts` after coordination changes.
- The live smoke script makes real model calls and executes generated code in a fresh temporary workspace. Report the actual result, including failures.
- Do not create further Git commits or publish changes unless the human authorizes them. The initial commit and public push were explicitly requested.
