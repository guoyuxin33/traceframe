# Roadmap

Traceframe is being built in visible, testable slices. Each milestone must keep the desktop application runnable.

## M1: Native workspace foundation

- [x] Tauri desktop shell and macOS bundle
- [x] conversation, code, diff, terminal, trace, context, memory, and agent views
- [x] native Git status, branch, and diff bridge
- [x] runtime-neutral event contract
- [x] CC Switch discovery and local proxy connection
- [x] selectable theme, density, and workspace balance
- [ ] workspace picker backed by the native dialog
- [ ] replace representative Git data with the selected workspace snapshot

## M2: Runtime integration

- [ ] Pi runtime adapter using SDK or RPC
- [ ] provider catalog and model capability normalization
- [ ] streamed runtime events from host to renderer
- [ ] tool permission broker with allow, ask, and deny policies
- [ ] cancellable runs and recovery after application restart

## M3: Multi-agent execution

- [ ] orchestrator-owned task graph
- [ ] isolated worktree per child agent
- [ ] per-agent model, budget, context, and permission profile
- [ ] conflict-aware review and merge queue
- [ ] reusable agent templates

## M4: Context and memory

- [ ] token accounting from real provider events
- [ ] configurable compaction checkpoints
- [ ] short-term session summaries
- [ ] project decisions and constraints store
- [ ] semantic long-term memory retrieval with provenance

## M5: Distribution

- [ ] signed and notarized macOS builds
- [ ] Windows and Linux bundles
- [ ] automatic updates and release channels
- [ ] crash recovery and opt-in diagnostics
