# Runtime architecture

This document separates the native runtime that exists today from the remaining multi-agent and isolation work. A rendered panel is not treated as an execution capability.

## Current desktop path

```text
Desktop UI
  -> Tauri commands and event channels
    -> Traceframe runtime
      -> Responses agent adapter -> CC Switch or OpenAI /v1/responses
      -> conversation adapters -> Anthropic or OpenAI-compatible streaming
      -> workspace tools -> guarded files, Git, bounded commands
      -> SQLite -> sessions, messages, summaries, memories, runtime events
```

The Rust host owns workspace authorization, provider requests, the root and specialist tool loops, cancellation, event persistence, and tool execution. The renderer chooses a provider, submits a run, and renders stored or live evidence.

Traceframe does not start Codex. Pi and pi-agent are architecture references only; no Pi process or SDK is connected.

## Responses agent

The `cc-switch-responses` and `openai-responses` adapters use the same Traceframe-owned loop:

1. Build instructions from the authorized workspace, branch, durable session summary, and scoped memories.
2. Send `POST /v1/responses` with `stream: true`, `store: false`, strict function tools, and the selected model.
3. Persist each normalized event before delivering it to the renderer.
4. Replay the complete response output, including reasoning items, and append `function_call_output` items for tool results.
5. Continue for at most 16 tool-enabled rounds. If the model uses the final tool round, send one additional request with tools disabled so it can summarize completed work and identify anything incomplete instead of discarding the last tool results.

Implemented tools are `list_files`, `read_file`, `edit_file`, `write_file`, `create_file`, `git_status`, `git_diff`, and `run_command`. Mutating file tools use the same authorized-root and conflict checks as the editor. Commands run directly without a shell and have program, argument-count, output-size, and timeout limits.

The root loop also receives a strict `delegate_task` tool. It may run up to four specialists serially. Each specialist inherits the selected provider, model, authorized workspace, and branch, receives a focused task, has an eight-tool-round limit plus the same tools-disabled final synthesis, and cannot delegate again. Serial execution prevents concurrent writes to the same checkout. A child result returns to the root as `function_call_output`; only the root's integrated answer is appended to the conversation.

## Provider boundaries

### CC Switch

`cc-switch-responses` is restricted to loopback hosts for both health checks and runtime requests. The default contract is:

```text
GET  http://127.0.0.1:15721/health
GET  http://127.0.0.1:15721/v1/models
POST http://127.0.0.1:15721/v1/responses
```

Traceframe deliberately omits `Authorization`, even if stale renderer state contains a key. CC Switch owns upstream credentials. Traceframe does not inspect CC Switch storage or manage its process.

### Direct providers

OpenAI Responses requests use bearer authentication. Anthropic uses its native Messages stream and headers. Other compatible providers use streamed `/chat/completions`; those adapters are conversation-only and are instructed not to claim file or command work.

Direct API keys exist only in renderer memory for the current application process. Endpoint and model preferences persist locally, but keys are excluded from local storage, SQLite, and repository files. Host-only secret storage remains planned.

## Model discovery

Provider health checks call `/models` and return the advertised IDs to the settings UI. CC Switch health is checked separately at `/health`, then its `/v1/models` route is queried. Empty model lists and discovery failures are reported differently.

The OpenAI settings include a small reference list from the official current text/code model catalog. Authenticated discovery replaces that reference with the connection's advertised list. Traceframe never silently substitutes a retired model ID.

## Event model

Runtime events contain an event ID, run ID, session ID, per-run sequence number, timestamp, type, and JSON payload. Events are appended to SQLite before they are emitted over the Tauri channel. The desktop restores recent events on startup.

Current events cover run creation, model requests and deltas, tool start/completion/failure, file changes, agent start/completion, usage, completion, cancellation, and failures. Agent and parent-agent IDs provide the current root-to-specialist causal link. A durable general task graph remains planned.

## Sessions, context, and memory

Sessions, messages, summaries, scoped memory records, and events persist in application-owned SQLite. Each run receives recent messages, the durable summary, and applicable session/project/global memories. The current explicit request wins over stored memory.

Manual compaction creates a deterministic bounded summary and records a `context.compacted` event. Provider usage is captured per run, but the visual context budget is not yet provider-authoritative. Automatic compaction, semantic retrieval, and model-generated memory extraction are not implemented.

## Workspace and process security

The Rust workspace bridge records roots selected through the native picker. It rejects parent traversal, symlink escapes, binary and non-UTF-8 files, truncated or oversized writes, and stale overwrites. Existing files are replaced atomically while preserving permissions.

Git operations and command working directories start inside the authorized workspace. The command tool is not an operating-system sandbox: allowed build tools and interpreters can execute repository code with the desktop user's permissions. The planned permission broker and process isolation layer must close that broader boundary before production use.

## Target multi-agent boundary

```text
Desktop UI
  -> Orchestrator
    -> child-agent scheduler and task graph
    -> isolated worktree manager
    -> runtime adapters
    -> permission broker and process isolation
    -> context and memory services
    -> append-only causal trace store
    -> review and merge queue
```

Current specialists share the selected checkout and therefore execute serially. The next boundary is an explicit worktree, independent context and permission profile, conflict review, and a merge decision for each child. Concurrent scheduling is not safe until those boundaries exist.
