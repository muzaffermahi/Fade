# Security reporting

Fade runs trusted local Pi tools with the user's OS permissions. Its execution lease coordinates the two roles; it is not a sandbox. External programs and installed extensions can change files. Use a separate temporary workspace for evaluating untrusted prompts or generated code.

Never put API keys or private conversation/session files in public issues. For a vulnerability, use the repository's Security → Report a vulnerability when private reporting is available. If it is unavailable, open an issue requesting a private reporting channel without including exploit details or secrets. Maintainers must establish the private channel before receiving sensitive material. No email address or response SLA is currently advertised.

Include the Fade candidate version/archive checksum, Node/OS/Pi versions, relevant extension list, a minimal reproduction using synthetic data, and expected versus observed behavior. Data loss, unintended execution, provenance loss, or an overlapping execution lease blocks release. Do not execute an exploit against another person's workspace.

/bug-report previews strict allowlisted metadata, excluding paths, IDs, URLs, raw errors, credentials, drafts, conversation, source and tool output. Explicit /bug-report export creates a new file under the canonical workspace after Builder quiesces; existing files, escaped parents and protected state are rejected. No upload occurs and native previews/exports do not enter model context. Review any reproduction text you add yourself before sharing. Trusted OS execution still applies; containment checks do not claim an OS sandbox against malicious external syscall races.

Only the current prerelease candidate is maintained while 1.0 qualification is pending. Dependencies are pinned by the lock; run npm audit --omit=dev during qualification and review advisories without automatically upgrading Pi's coupled packages independently.
