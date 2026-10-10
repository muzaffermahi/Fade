# Fade implementation status

| Work order | Status | Command summary |
| --- | --- | --- |
| FADE-MVP — standalone terminal experiment from the human's build brief | passed | Strict TypeScript checks and production build exit 0; 14 automated tests pass; real Pi/OpenCode Go DeepSeek V4.1 Flash A → B transition passes; six generated notebook tests independently pass. |

Verified on 2026-10-10 (Asia/Shanghai), Node 24.14.1, Windows, Pi SDK 0.73.1. Existing parent repository files and statuses were preserved.

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

Earlier exploratory tests exposed malformed output from a local model and an OpenCode Go request missing its session-routing header. The user then requested cloud-only testing. Fade now defaults to DeepSeek V4.1 Flash, supplies the required header, and makes one bounded tool-less formatting repair when JSON is invalid. The final live result above used OpenCode Go, not a local model.

## Remaining limitations

No blocker remains for the terminal MVP. Companion interpretation still needs human use to assess its quality; quoted evidence does not guarantee semantic fidelity. The Companion buffers structured replies rather than streaming prose. Shell execution is trusted local execution, not an OS sandbox. The deprecated requested SDK has unresolved upstream advisories. No web UI, cloud sync, alternate coding harness, or production deployment was added.
