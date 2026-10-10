# Fade implementation contract

This independent project was authorized by the human's new build brief. Its product name, folder, terminal command, and public GitHub repository are **Fade**. The older parent project's v0.2 work orders and serialized contracts do not define this new experiment. Preserve all parent files.

Fade is a tool for the mind. The Builder implements the present; the Companion helps the human develop the future. Do not turn the human into an agent supervisor or add routine approvals.

- Keep the implementation small: two Pi roles and the coordinator.
- Interactive `Fade` uses Pi's real InteractiveMode, branded Fade. Every ordinary prompt must enter Fade's loop automatically. Preserve Pi's editor, themes, keybindings, and native dialogs; never fall through into an independent Pi model loop.
- The Companion has no code or shell tools. Never let discovery events invent human decisions.
- Future slices use settled, evidence-backed intent. Preserve tentative thoughts and conflicts visibly.
- The active Builder brief is immutable. Redirection must be explicit.
- Preserve event logs and decision provenance. Model verification strings are claims, not proof.
- Use strict TypeScript and validated external payloads. Do not bypass contracts with casts or `any`.
- Canonical file paths must stay inside the application workspace and outside `.fade` and `.git`. Shell execution is trusted local execution, not a security sandbox; retain the explicit nonroutine command gate.
- Reuse Pi's configured model and credentials. Do not hardcode a preferred provider or model. Explicit role overrides remain available; cloud test models are selected explicitly for each test run. Never commit credentials, conversation state, or generated workspaces.
- Run `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.test.json` and `node --import tsx --test tests/*.test.ts` after coordination changes.
- The live smoke script makes real model calls and executes generated code in a fresh temporary workspace. Report the actual result, including failures.
- Do not create further Git commits or publish changes unless the human authorizes them. The initial commit and public push were explicitly requested.
