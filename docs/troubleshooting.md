# Troubleshooting

Start with /doctor for local readiness and /status for current work. /diagnostics contains routine SDK/resource/storage notices. None of these inspection commands starts a provider turn.

- **No model or authentication:** use native /model and /login. Check explicit role overrides. Credential presence does not establish network reachability or quota.
- **Unknown model or local context failure:** use a registered provider/model ID. Match the local loaded context with models.json; a server loaded at 8K cannot satisfy a larger configured window. Errors remain saved; changing a model does not replay uncertain work.
- **429, refused connection, empty/malformed response or disconnect:** inspect /inputs and provider cause. Edit or explicitly /retry-input after correcting configuration/availability. Stock Pi retries/compaction are visible; Fade never blindly resubmits an uncertain accepted command.
- **Cancellation still says cancelling:** provider/tool work has not quiesced yet. Ownership is retained until it stops; terminal silence does not establish success. A provider-turn deadline also requests cancellation before reporting its uncertain result.
- **Mixed queue after interruption:** another extension has queued original messages. Fade preserves those messages and blocks replay of interrupted owned input. Use native /pi queue controls to dequeue, then explicitly retry what you intend.
- **Builder has no work:** exploration and quoted suggestions do not authorize edits. Request a concrete bounded change and checks. /intent shows source decisions; resolve conflicts with Ctrl+E and use /rethink.
- **Paused or blocked work:** partial files remain. Inspect /builder, /changes and /log. /continue is explicit; /stop disables automatic continuation; /redirect retains old work and develops a replacement.
- **Acceptance is unverified:** model summaries/verification strings are claims. Required executable checks need paired observed results for the exact command, after the current boundary. A manual criterion needs /accept-check with human evidence. Unrelated successes cannot erase a failed command.
- **Storage failure or lock:** repair disk/permissions/integrity and restart. Never delete a journal to hide an error. Live locks cannot be bypassed; inspect invalid/moved paths before recovery. Preview support metadata locally if export cannot acquire the execution lease.
- **Bash missing:** install Bash/Git for Windows and restart with Bash available. /doctor resolves presence without executing a command.
- **Display/input:** /settings honors Pi light/dark/custom themes; NO_COLOR keeps textual states. Tab accepts completion before switching panes. Escape closes UI first, then interrupts the focused role. Ctrl+C and Ctrl+D follow the documented ordered exit controls. Use --plain for a basic terminal.
- **Older reading/history:** PageUp/PageDown preserves the focused logical page during output/resize. New output is labelled; returning to the tail clears it. /history, /inputs, /reports and /log support page:N and search; /history metadata exposes preserved cold project metadata.
- **Incomplete changes:** snapshots skip binary/link/large/overflow content. Context diffs label limitations and external attribution uncertainty. Fade never restores a snapshot over current files.
- **Native Pi resume hint:** launch Fade in the workspace to restore the coordinated project, then inspect saved inputs before /continue. Pi's own resume command opens a native session.

## A local diagnostic report

/bug-report previews exactly the redacted metadata fields: versions, environment, authentication presence, storage/activity flags and recent receipt counts. It excludes private content, paths, IDs, URLs, raw errors and all tool/source text.

/bug-report export [relative-path.json] explicitly creates a new file under the canonical workspace root. Builder stops first and remains paused. Existing files, protected state and escaped links are rejected. Native results remain local inspection, not model context. No upload occurs. Review any additional reproduction text you add yourself before sharing.

Include a synthetic reproduction, candidate checksum, OS/terminal/Node and selected provider information you choose to share. For sensitive vulnerabilities follow SECURITY.md; do not put credentials or private sessions in public issues.

