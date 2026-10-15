# Changelog

## 0.5.0 — Final pass (local release candidate)

Stable conversation geometry, deterministic action replies, checked/not-checked wording, clearer
startup/recovery, shorter prompts, explicit extension loading and a current terminal demo.
MCP, codemode and tool_search remain. See final-pass-results.md for verification and pending gates.

## 0.4 — One conversation (2026-10-15)

Replaced the dual-pane card controls with one conversation and a Builder rail. Added quiet,
independently checked landings, exact-checkpoint undo, natural corrections and human taste questions.
Removed visible goals and counters; restored double Ctrl+C. Bundled web search/fetch and focused
Python/JavaScript/TypeScript checks; retained native Builder MCP, codemode and discovery.

Earlier Slice A tests validated real version changes, undo, failed commands and Windows shell handling.
The pre-final-pass suite passed 86 tests; actual web search/fetch and a real Python repair passed.
An uninterrupted Kimi conversation passed version → undo → direction → ordinal selection → look → yes.
Flash runs also exposed inconsistent instruction following; those failures remain evidence, not passes.
These were agent-operated tests, not a first-time-user study. Current final-pass evidence lives in
[final-pass-results.md](final-pass-results.md); local logs remain under output/.
