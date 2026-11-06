# Traceframe

Traceframe is a desktop workspace for transparent, multi-agent software development. It keeps conversation, tool execution, file changes, Git branches, context compaction, and memory on the same trace.

## Current state

The first development milestone includes:

- a native Tauri desktop shell for macOS
- a dense workspace for sessions, conversation, code, diffs, terminal output, and execution traces
- model provider and endpoint configuration without persisting API keys
- context budget, compaction policy, memory, and agent topology views
- a native workspace picker with recent-workspace recovery
- live repository files, text previews, Git status, branches, and staged/unstaged diffs
- guarded local branch switching with Git refusal surfaced in the workspace
- a runtime-neutral event contract for Pi and other agent backends

The selected repository workspace is live. Conversation, agent execution, context, and memory panels still use representative events until the first runtime adapter is connected.

Workspace access stays behind the Rust host. File previews are confined to the selected canonical directory, binary files are rejected, large previews are truncated, and generated dependency/build directories are excluded from the explorer.

## Development

Requirements: Node.js 22+, Rust 1.84+, and the platform prerequisites for Tauri 2.

```bash
npm install
npm run desktop:dev
```

Build the macOS app and DMG:

```bash
npm run desktop:build
```

## Architecture

The UI consumes an append-only runtime event stream. Agent runtimes are adapters, not product boundaries. The planned Pi adapter uses its unified model API and agent loop; orchestration, worktree isolation, permissions, context policy, and memory remain Traceframe services.

See [docs/runtime-architecture.md](docs/runtime-architecture.md) for the event and process boundaries.

## Design credit

The interface was reviewed with [unslop](https://github.com/heydamir/unslop), created by Damir Sokolovsky, under CC BY 4.0.
