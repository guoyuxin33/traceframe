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

## Permission and approval lifecycle

The run request carries one of two file permission modes: `request-approval` or `full-access`. Both use a host-owned `WorkspaceChangeJournal`; the difference is whether the resulting batch waits for a user decision.

1. Before `edit_file`, `write_file`, or `create_file`, the journal captures the target's content, existence, and Unix mode. Before `run_command`, it captures the repository inventory and relevant versions so new, modified, and deleted files can be detected. A snapshot is capped at 8 MiB per file and 128 MiB per run.
2. After the Responses loop returns, the host compares the captured versions with disk, builds unified diffs and line ranges, and persists an approval batch plus its before/after versions in SQLite.
3. In `request-approval` mode, an `approval.requested` event is appended and the run waits. The renderer can accept or reject one pending file or the whole batch. Accept leaves the after-version in place. Reject restores the before-version, including content, existence, and Unix mode. The host first verifies that the current file still equals the reviewed after-version; it will not overwrite a newer user or process edit. A failed multi-file restore attempts to compensate files already restored before returning an error.
4. Each decision updates the file status and appends an immutable user audit record. The host emits `approval.resolved` only when the batch has no pending files, then persists the assistant message and terminal run event.
5. In `full-access` mode, the same batch and diffs are persisted as policy-accepted, `approval.resolved` is emitted immediately, and the run does not wait.

The model's edits are already present on disk while a `request-approval` batch is pending; the security property is exact reversible review rather than pre-write authorization. The journal cannot make arbitrary repository code safe to execute, so command allowlisting and the planned process-isolation boundary remain separate concerns.

MCP approval is a distinct mid-run lifecycle. Enabled remote MCP servers are serialized as Responses `mcp` tools. HTTPS is required except for loopback HTTP, credentials cannot be embedded in URLs, labels are validated, and optional authorization is sent only from the current in-memory configuration. An individual server's `never` policy bypasses per-call approval only when the whole run is also in `full-access`; every other combination sends `require_approval: always`.

When a provider returns an `mcp_approval_request`, the host registers the request against the active run, appends `mcp.approval.requested` with the server, tool, and arguments, and waits without advancing the model transcript. `mcp_approval_decide` requires both the run ID and approval request ID. It wakes the run with an allow or reject decision, after which the host appends `mcp.approval.resolved` and an `mcp_approval_response` output item for the next Responses turn. Cancelling while either file or MCP approval is pending produces a cancelled run instead of silently accepting work.

Approval UI is attached to the conversation run segment containing the requested or resolved event rather than collected in one panel after the conversation. Message timestamps, run start times, and active-run guidance boundaries determine segment order, so an approval is shown before later assistant message cards while its execution evidence remains with the run that produced it. Scrolling upward disables automatic following until the user selects `Latest`.

## Skills and MCP configuration

The desktop discovers `SKILL.md` files below user-selected local roots, ignoring symlinks and common vendor/build directories. Enabled skills are read again at run start and wrapped as instruction sections for the root and delegated specialists. Discovery is bounded to 256 files and six directory levels; runtime loading is bounded to 16 enabled skills, 256 KiB per file, and 512 KiB total. Skill settings persist paths and enablement, not a copied instruction body.

Remote MCP settings persist endpoint metadata, server labels, tool allowlists, approval policy, and enablement. Authorization is intentionally omitted from persisted settings and must be supplied again after restart. The native health check performs a bounded MCP `initialize` request; endpoint validation allows HTTPS or loopback HTTP and rejects URL credentials and fragments. Runtime MCP tools are currently available only through the Responses adapters.

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

Current events cover run creation and steering, model requests/deltas/completion, tool start/completion/failure, file changes, agent start/completion, usage, completion, cancellation, and failures. `run.steered` records the root turn boundary where queued guidance entered the model transcript. Tool events and their `file.changed` records share a `callId`, allowing the renderer to pair arguments, duration, result, edited paths, line ranges, and agent lifecycle into collapsible evidence instead of duplicate start/result rows. The renderer also closes unfinished steps against a terminal run state, activates Code, loads the edited file directly, centers the range, and marks it once; it does not rescan the whole repository for every file event. Manual navigation pauses following, duplicate event IDs are ignored, and unsaved drafts block automatic replacement until they are saved or reverted. Startup snapshots omit replay-only model deltas and retain a bounded recent event window; selecting a session separately fetches its latest 1,000 audit events so a busy set of newer sessions cannot erase that session's visible trace. Agent and parent-agent IDs provide the current root-to-specialist causal link. A durable general task graph remains planned.

File approval adds `approval.requested` and `approval.resolved`; MCP adds `mcp.approval.requested` and `mcp.approval.resolved`. File batches and their decisions have dedicated durable tables in addition to the event records. MCP decisions are scoped to the live run, while their requested and resolved events remain part of the durable trace.

While a run owns the workspace, the conversation remains writable. The composer defaults to `Guide run` for Responses agents and can switch to `Queue next`. The host accepts at most 16 pending guidance messages of 2,000 characters each, persists them in SQLite, and closes the inbox atomically when natural completion wins the race. Follow-up prompts are held in a visible per-session renderer queue and submitted serially after the active run completes. Stopping a run preserves those pending turns but pauses automatic execution; the user can remove them or explicitly run the next item. The follow-up queue is process-local; accepted guidance, user messages, and completed run output remain durable in SQLite.

## Sessions, context, and memory

Sessions, messages, summaries, scoped memory records, and events persist in application-owned SQLite. Each run receives recent messages, the durable summary, and applicable session/project/global memories. The current explicit request wins over stored memory.

Manual compaction creates a deterministic bounded summary and records a `context.compacted` event. Provider usage is captured per run, but the visual context budget is not yet provider-authoritative. Automatic compaction, semantic retrieval, and model-generated memory extraction are not implemented.

## Workspace and process security

The Rust workspace bridge records roots selected through the native picker. It rejects parent traversal, symlink escapes, binary and non-UTF-8 files, truncated or oversized writes, and stale overwrites. Existing files are replaced atomically while preserving permissions.

Git operations and command working directories start inside the authorized workspace. User-triggered Git mutations use argv-only host commands under the workspace write lock: checkout and commit hooks are disabled, commit signing is disabled, pull is fast-forward-only with a clean worktree, and push targets the exact upstream or explicitly publishes an untracked branch to `origin`/the sole remote. Git commands run in their own process group on Unix so timeouts terminate helper and SSH descendants as well as the direct child; bounded readers keep draining both pipes so oversized previews cannot deadlock a child. A completed mutation is reported separately from a failed post-operation status refresh. Command file detection uses one status plus global staged and working diffs per snapshot, keeping Git process count constant as the number of changed files grows. Agent commands likewise run in a process group, drain output pipes to EOF, and retain bounded output. The command tool is not an operating-system sandbox: allowed build tools and interpreters can execute repository code, including invoking Git indirectly, with the desktop user's permissions. The planned permission broker and process isolation layer must close that broader boundary before production use.

## Git topology and dock state

Source Control combines mutation commands with a separate read-only topology snapshot. The native graph command reads `HEAD`, local branches, remote refs, tags, commit parents, authors, dates, and subjects using bounded argv-only Git commands; annotated tags are peeled to the commit they describe. Commits are requested in `--topo-order` across refs, default to 200 entries, and are capped at 500. The renderer assigns lanes from real parent hashes, preserves merge edges, labels refs at their commits, reports when history or parent connections continue beyond the bounded window, and exposes keyboard-accessible commit selection with identity, author, refs, and navigable parent details.

The workspace layout uses a versioned FlexLayout model. Every panel tab can be dragged, resized, or closed. A center drop joins an existing tabset, while a top, right, bottom, or left edge drop creates a split. Removing the final tab deletes its empty tabset and collapses the surrounding row so the remaining panels reclaim the space. Layout persistence records each visible panel's latest tabset before it is closed. The left-rail restore action first returns it to that tabset when it still exists; removed targets and older layouts fall back through the panel's functional group, the active tabset, and the first available tabset. Appearance can replace the saved layout with the selected balanced, code, or conversation preset. Schema migration removes empty v7 tabsets, adds newer Preview and Terminal tabs to their intended groups, and rejects duplicate, unknown, or incompatible layouts instead of guessing.

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
