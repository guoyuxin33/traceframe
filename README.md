# Traceframe

Traceframe is a desktop workspace for transparent, multi-agent software development. It keeps conversation, tool execution, file changes, Git branches, context compaction, and memory on the same trace.

## Current state

The first development milestone includes:

- a native Tauri desktop shell for macOS
- a dense workspace for sessions, conversation, code, diffs, terminal output, and execution traces
- model provider and endpoint configuration without persisting API keys
- context budget, compaction policy, memory, and agent topology views
- native Git status, branch, and diff commands behind a narrow Rust bridge
- a runtime-neutral event contract for Pi and other agent backends

The interface currently runs against representative local data while the runtime adapter is connected.

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
