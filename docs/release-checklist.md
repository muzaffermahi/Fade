# Fade 1.0 release qualification

Every unchecked item is an open gate. A passing deterministic suite is not release qualification. Record candidate archive hash, OS/terminal/Node versions, selected models, hardware, commands, captures and outcomes for each rehearsal. Never include credentials or private conversations in committed evidence.

The 2026-10-12 readiness revision authorizes F13–F24 independently of open F07/F08 external gates. F25 reconciles those gates against the final artifact; only real results qualify. See docs/readiness-plan.md for the complete mandatory matrix and performance targets.

- [x] F13–F24 engineering acceptance passes with gap dispositions and current-screen assertions. Source verification: 177/177 tests; external qualification remains below.
- [x] Final `@muzaffermahi/fade` archive with both executable aliases has a recorded SHA-256 and intentional public inventory. rc.2 SHA `c91761bf53e6a0f33a1eff69c9b3c23b270794cc3472f2b3b2f1a6d737ac9340`, 116 files; Windows Node22/24 alias rehearsals pass.
- [ ] Windows/macOS/Linux CI and clean installs pass on Node 22 and 24; real previous-version upgrade/migration is verified.
- [ ] Windows Terminal, macOS Terminal and a Linux terminal complete physical IME/Unicode/paste/theme/resize/scroll/streaming qualification.
- [ ] Explicitly selected cloud provider and local OpenAI-compatible endpoint pass against the exact packaged candidate; failed runs retained.
- [ ] Final split UI meets startup ≤2s, input echo p95 <50ms, received activity/completion ≤250ms and bounded long-history memory/disk measurements on recorded hardware.
- [ ] Redacted local-only diagnostic export and synthetic demo/Reddit drafts contain no secrets/private content or unqualified support claims.
- [ ] F25 and F26 complete; publication still awaits separate authorization.

- [ ] F01–F07 acceptance and recorded verification pass in order.
- [ ] Packaged CLI installs, configures, launches, upgrades and uninstalls on clean Windows, macOS and Linux machines.
- [ ] Exploration makes no edits; a concrete supported request starts a slice.
- [ ] Companion conversation continues while Builder performs a real edit and check.
- [ ] Conflicts hold future work, preserve active snapshot, and can be resolved in the terminal.
- [ ] Discoveries affect understanding without inventing human decisions.
- [ ] Rapid input, native steering/follow-up, queue editing/cancellation, attachments and session switches preserve destination and order.
- [ ] Pause, redirect, crash, disconnect and retry preserve partial work and honest receipts. No uncertain operation automatically replays.
- [ ] Recorded tool results distinguish model claims; failed checks never appear verified.
- [ ] External edits remain intact with uncertain attribution visible.
- [ ] Real InteractiveMode/PTY captures at 80×24, 120×40 and live resize; long pastes, Unicode/CJK/IME, scroll/focus restoration, light/dark themes, plain fallback and sustained streaming.
- [ ] Reference hardware measured: warm usable startup ≤2 seconds; input echo p95 <50 ms; activity projection ≤250 ms after received events. Provider latency measured separately.
- [ ] Provider failure/cancellation/shutdown/storage/context/long-session fault tests leave no stuck queue or abandoned process.
- [ ] v1 migration rehearsal from a copy preserves conversations, decisions, receipts and slice history with a backup and paused recovery.
- [ ] Explicitly selected real-provider evaluations pass against the packaged candidate; record actual outcomes including failures.
- [ ] At least five unfamiliar developers independently install, start useful work, think during implementation, inspect, redirect and resume after interruption. At least four complete without coaching. Record anonymized results.
- [ ] Zero data loss or unintended execution in qualification. Either blocks release.

F08 cannot be declared passed from local automation alone: the unfamiliar-developer gate and clean-machine platform rehearsals require actual participants/environments. Keep the candidate prerelease until evidence exists. Publication requires separate human authorization.
