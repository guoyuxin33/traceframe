# Changelog

This project has no tagged public release yet. The current package version is `0.3.0`, an unsigned developer preview.

## Unreleased

### Added

- Native macOS Tauri workspace with a host-authorized repository picker.
- Bounded file preview, Git status, staged and unstaged diffs, and switching between existing local branches.
- Configurable appearance and dock layout.
- Editable workspace files with atomic conflict-checked saves and explicit revert behavior.
- Persisted sessions, messages, scoped memories, summaries, and ordered runtime events.
- Traceframe-owned Responses agent loop with file, Git, and bounded command tools.
- Bounded serial specialist delegation with inherited provider/model/workspace scope, parent/child trace events, and non-recursive child tools.
- Direct OpenAI Responses and local CC Switch Responses adapters with model discovery.
- Anthropic and OpenAI-compatible streamed conversation adapters.
- Official current OpenAI text/code model catalog reference in settings.
- Line-aware agent edit following that activates Code, opens the changed file, centers and marks the affected range, and can be paused for manual navigation.
- Per-session follow-up prompt queues with Enter-to-send, Shift+Enter multiline input, visible ordering, removal, and automatic serial execution.

### Changed

- CI builds the renderer, tests the Rust host with its lockfile on stable and Rust 1.84, checks Rust formatting, and builds the macOS desktop bundle.
- Project documentation distinguishes implemented behavior, representative UI, and planned capabilities.
- Retired model defaults are cleared instead of silently reused.
- Compacted messages are excluded from later runtime input while their durable summary remains available.
- Non-Responses provider requests can be cancelled while waiting for response headers and record terminal failures consistently.
- Responses runs use a tools-disabled synthesis request after exhausting their tool-round budget instead of failing immediately after the last successful tool call.
- File paths emitted by mutating runtime tools are normalized before renderer navigation.

### Fixed

- Opening the native workspace picker no longer blocks the Tauri event loop; the dialog is asynchronous, parented to the application window, visibly pending, and guarded against duplicate opens.
- Cancelling the picker or selecting a non-Git directory preserves the last successfully loaded workspace, and invalid directories are not saved as recent workspaces.
- Manual file navigation and unsaved editor drafts no longer lose races with pending agent-follow refreshes.
- Agent edit navigation runs once per event and no longer resets the caret while the user continues editing.

### Security

- Workspace file and Git access remain behind the Rust host's authorized-root boundary.
- Manually entered API keys are excluded from repository files, local storage, and the application SQLite database in the current development flow.
- CC Switch routes are restricted to loopback and never receive renderer-supplied authorization headers.
- Non-UTF-8 previews are rejected at every file size, including truncated previews.
