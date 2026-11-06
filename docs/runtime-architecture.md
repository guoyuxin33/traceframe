# Runtime architecture

## Boundary

Traceframe treats an agent runtime as a replaceable execution engine. The desktop app owns the durable session, trace, permission, Git, context, and memory records. A runtime owns the model/tool loop for one run.

```text
Desktop UI
  -> Tauri command/event bridge
    -> Orchestrator
      -> Runtime adapter (Pi, Codex, Claude, custom)
      -> Permission broker
      -> Worktree manager
      -> Context and memory services
      -> Append-only trace store
```

## Why Pi is the first reference adapter

Pi already separates the unified model API, agent loop, coding tools, SDK, and RPC surfaces. That maps cleanly to Traceframe's boundaries. Traceframe should use the agent loop and provider normalization, while keeping these concerns above the adapter:

- child-agent scheduling and dependency graphs
- per-agent worktree isolation
- filesystem, process, network, and credential permissions
- durable run and event history
- context compaction policy and long-term memory
- human review gates and merge policy

Pi intentionally leaves some of these out, which is useful: the adapter stays small and upstream updates remain adoptable.

## Event model

Every visible state change is derived from an ordered runtime event. Events carry a trace ID, optional parent ID, sequence number, timestamp, agent ID, type, and typed payload. The initial contract lives in `src/runtime/contracts.ts`.

The UI never infers a file change from chat text. It receives `file.changed`. The same rule applies to worktrees, branches, context compaction, memory writes, tool execution, and run completion.

## Process model

Each run receives an explicit workspace, branch, model, context policy, and permission profile. Child agents inherit the trace ID but receive their own agent ID, worktree, cancellation token, and token budget.

Provider credentials stay in the host process or operating-system credential store. They are not sent to the renderer and are never written to the repository.
