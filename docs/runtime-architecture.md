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

## Pi-derived loop boundaries

Traceframe follows the useful boundaries in Pi's agent design without importing its Node runtime:

- the Rust host owns a provider-neutral run loop, cancellation, workspace authority, tool execution, and durable event order;
- provider adapters translate wire formats, while the canonical transcript keeps complete model output items and normalized tool results;
- steering instructions are a bounded host-side inbox consumed by the root loop at assistant or tool turn boundaries;
- follow-up prompts are a distinct next-run queue rather than being mixed into the active request;
- child capabilities are host-owned profiles, so a model can choose a suitable specialist but cannot grant it broader tools;
- every tool result is transformed to a bounded model-facing representation before the next provider request, while the trace keeps a separately bounded audit representation.

Pi-style steering and follow-up are separate controls. `Guide run` persists a user instruction and adds it to the active Responses run's FIFO inbox; the root loop injects it after the current assistant or tool batch without interrupting a command or file write. `Queue next` creates a renderer-managed follow-up that starts a new run after the current one completes. If the host has already claimed completion or the selected adapter is conversation-only, guidance is rejected explicitly and the renderer keeps it as the next queued turn.

## Responses agent

The `cc-switch-responses` and `openai-responses` adapters use the same Traceframe-owned loop:

1. Build instructions from the authorized workspace, branch, durable session summary, and scoped memories.
2. Send `POST /v1/responses` with `stream: true`, `store: false`, strict function tools, and the selected model.
3. Persist each normalized event before delivering it to the renderer.
4. Replay the complete response output, including reasoning items, and append `function_call_output` items for tool results.
5. Continue for at most 16 tool-enabled rounds and 32 total model turns. Steering-only turns do not consume the tool budget. If the model uses the final tool round, send another request with tools disabled so it can summarize completed work and identify anything incomplete instead of discarding the last tool results.

Implemented tools are `list_files`, `read_file`, `edit_file`, `write_file`, `create_file`, `git_status`, `git_diff`, and `run_command`. Mutating file tools use the same authorized-root and conflict checks as the editor. Commands run directly without a shell and have program, argument-count, output-size, and timeout limits.

The root loop also receives a strict `delegate_task` tool. It may run up to four specialists serially. Each specialist inherits the selected provider, model, authorized workspace, and branch, receives a focused task, has an eight-tool-round limit plus the same tools-disabled final synthesis, and cannot delegate again. The host enforces one of three profiles: `scout` and `reviewer` receive only read, tree, status, and diff tools; `worker` receives mutating file and bounded command tools as well. Tool authorization is checked again during execution even if a provider returns a tool call that was not advertised. Serial execution prevents concurrent writes to the same checkout. A child result returns to the root as `function_call_output`; only the root's integrated answer is appended to the conversation.

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

Before the first snapshot is exposed, startup reconciles interrupted runs in the store layer. A run with `run.created` but no completion, failure, or cancellation is atomically given a sequenced `run.failed` event with `reason: app_interrupted` and a visible Runtime system message. The transaction is idempotent, so later launches do not duplicate either record.

Current events cover run creation and steering, model requests and deltas, tool start/completion/failure, file changes, agent start/completion, usage, completion, cancellation, and failures. `run.steered` records the root turn boundary where queued guidance entered the model transcript. Mutating file tools include a normalized relative path and changed line range in `file.changed`. Bounded commands compare per-file Git fingerprints before and after execution, so formatter and generator changes also emit file events. The renderer uses that evidence to activate Code, load the file, center the range, and mark it once. Manual navigation pauses following, duplicate event IDs are ignored, and unsaved drafts block automatic replacement until they are saved or reverted. Agent and parent-agent IDs provide the current root-to-specialist causal link. A durable general task graph remains planned.

While a run owns the workspace, the conversation remains writable. The composer defaults to `Guide run` for Responses agents and can switch to `Queue next`. The host accepts at most 16 pending guidance messages of 2,000 characters each, persists them in SQLite, and closes the inbox atomically when natural completion wins the race. Follow-up prompts are held in a visible per-session renderer queue and submitted serially after the active run completes. Stopping a run preserves those pending turns but pauses automatic execution; the user can remove them or explicitly run the next item. The follow-up queue is process-local; accepted guidance, user messages, and completed run output remain durable in SQLite.

## Sessions, context, and memory

Sessions, messages, summaries, scoped memory records, and events persist in application-owned SQLite. Each run receives recent messages, the durable summary, and applicable session/project/global memories. The current explicit request wins over stored memory.

Manual compaction creates a deterministic bounded summary and records a `context.compacted` event. Provider usage is captured per run, but the visual context budget is not yet provider-authoritative. Automatic compaction, semantic retrieval, and model-generated memory extraction are not implemented.

## Workspace and process security

The Rust workspace bridge records roots selected through the native picker. It rejects parent traversal, symlink escapes, binary and non-UTF-8 files, truncated or oversized writes, and stale overwrites. Existing files are replaced atomically while preserving permissions.

Git operations and command working directories start inside the authorized workspace. Commands run in their own process group on Unix so cancellation terminates the spawned process tree, and output pipes are drained to EOF while retained output remains bounded. The command tool is not an operating-system sandbox: allowed build tools and interpreters can execute repository code with the desktop user's permissions. The planned permission broker and process isolation layer must close that broader boundary before production use.

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
