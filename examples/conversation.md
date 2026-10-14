# Try Fade in a temporary project

Explore: “What if this notebook organized ideas by mood?” Nothing should be implemented from this.

Implement: “Implement notes.mjs exporting addNote(notes, text) as a new array, plus a dependency-free test. Run the test. Do not add a UI or dependencies.” Builder should start a bounded supported slice.

While it builds: “How might search feel like retrieving a thought? Compare two designs.” The Companion can inspect and develop the idea while Builder owns edits.

Settle future work: “Implement case-insensitive substring searchNotes(notes, query) next, with a real test. Keep the array representation.” The active brief stays unchanged; future work waits for dependencies and reconciliation.

Inspect /builder, /status, /intent, /changes and /log. In /intent use Ctrl+E to edit or resolve a conflict. Escape returns to the composer. /builder <question> sends a saved note to the active Builder. /inputs distinguishes acceptance, queueing and processing.

/pause retains partial work. /redirect Implement a smaller replacement with its checks preserves old history. /stop disables continuation. After restart, inspect saved inputs and use /continue only when ready. /quit saves and exits.
