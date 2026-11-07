# Roadmap

Checked items exist in the current development tree. Visible controls are not marked complete until their native behavior works.

## Implemented foundation

- [x] native Tauri desktop shell and macOS bundle
- [x] draggable, resizable, persistent multi-tab workspace layouts
- [x] host-authorized workspace picker and recent-workspace recovery
- [x] bounded repository tree, editable text preview, guarded save and revert
- [x] Git status, staged and unstaged diffs, branch list, and guarded branch switching
- [x] SQLite persistence for sessions, messages, summaries, scoped memories, and runtime events
- [x] session create, search, archive, restore, and message history
- [x] Traceframe-owned Responses tool loop with cancellation, 16 tool rounds, and a tools-disabled final synthesis
- [x] bounded serial child-agent delegation with inherited run scope and non-recursive child tools
- [x] visible parent/child agent lifecycle and tool events
- [x] file list/read/edit/write/create, Git status/diff, and bounded command tools
- [x] CC Switch local Responses route without renderer-supplied credentials
- [x] direct OpenAI Responses, Anthropic, and OpenAI-compatible streaming providers
- [x] provider health checks, live model discovery, and official OpenAI catalog reference
- [x] in-memory API key flow that excludes keys from persistence and repository files
- [x] deterministic manual session compaction and scoped memory injection
- [x] real-time output, trace, tool timing, usage, file-change, failure, and cancellation views
- [x] streamed mock Responses tests covering delegation and post-budget synthesis
- [x] real PTY terminal rooted in the authorized workspace, with streaming input/output and resize support
- [x] local project process lifecycle, loopback preview loading, logs, and restart-and-refresh
- [x] preview element selection with structured context appended to the active conversation draft
- [x] explicit Preview-to-Terminal command staging without automatic execution

## Runtime hardening

- [ ] move direct-provider credentials into host-only or operating-system secret storage
- [ ] add allow, ask, and deny policies before every mutating tool
- [ ] isolate development commands beyond the current allowlist, timeout, and output limits
- [ ] recover or reconcile interrupted runs after application restart
- [ ] add renderer reconnect and event-channel backpressure behavior
- [ ] persist opaque reasoning continuity across user turns where provider policy permits it
- [ ] handle provider refusal output as a first-class terminal response
- [ ] add provider refusal, malformed stream, reconnect, and backpressure integration coverage

## Multi-agent execution

- [x] Traceframe-owned root-to-specialist delegation loop with a four-child run budget
- [x] provider/model/workspace/branch inheritance for delegated specialists
- [x] causal parent/child IDs in live and persisted runtime events
- [ ] persistent task graph and concurrent child-agent scheduler
- [ ] isolated worktree per child agent
- [ ] per-agent provider, model, budget, context, and permission profile
- [ ] conflict-aware review and merge queue
- [ ] reusable agent templates

## Context and memory

- [ ] provider-authoritative context accounting and budget enforcement
- [ ] automatic, policy-driven compaction checkpoints
- [ ] model-generated short-term summaries with provenance
- [ ] semantic long-term retrieval with provenance and deletion controls
- [ ] explicit memory conflict and supersession handling

## Preview and deployment

- [x] start, stop, and atomically restart a local development server
- [x] sandboxed loopback preview with redirect validation and bounded HTML loading
- [x] select a rendered element and send its inspectable context to the conversation composer
- [ ] detect framework-specific development commands and ports
- [ ] stream live reload state and build diagnostics into Preview
- [ ] add deployment provider adapters with explicit confirmation, progress, logs, and hosted URL capture
- [ ] keep per-workspace preview and deployment profiles

## Distribution

- [ ] signed and notarized macOS builds
- [ ] Windows and Linux bundles
- [ ] automatic updates and release channels
- [ ] crash recovery and opt-in diagnostics
