# Traceframe

Traceframe is a native Tauri coding workspace that keeps model activity, tool calls, file changes, Git state, context, and memory visible while a task runs.

![Traceframe workspace](docs/assets/traceframe-workspace.png)

_Traceframe 0.3 running as a native macOS application with a real local repository loaded._

## Current development build

| Status | Capability |
| --- | --- |
| Implemented | Native macOS shell; draggable and resizable persistent dock tabs; authorized workspace picker; bounded file tree; editable UTF-8 file preview with conflict detection; Git status, diffs, and branch switching; persisted sessions, messages, scoped memories, summaries, and runtime events |
| Implemented | Traceframe-owned Responses API agent loop with streamed output, cancellation, queued follow-up turns, up to 16 root tool rounds followed by a tools-disabled final synthesis, file and Git tools, bounded development commands, timing, usage, and line-aware file-change events |
| Implemented | Model-directed serial delegation to as many as four bounded child agents per run, with inherited provider/model/workspace scope, non-recursive child tools, and visible parent/child events |
| Implemented | Direct OpenAI Responses, local CC Switch Responses routing, Anthropic streaming, and OpenAI-compatible chat providers; provider health checks and model discovery |
| Planned | Isolated child worktrees, conflict-aware merge queues, per-agent configuration, authoritative context budgets, and interactive terminal input |

Traceframe does not launch Codex or delegate its coding loop to a Codex process. The Rust host sends requests to the selected model provider and executes Traceframe's own tools.

## Models and authentication

### CC Switch

The built-in CC Switch provider connects only to a loopback endpoint, by default `http://127.0.0.1:15721/v1`.

- Health: `GET /health`
- Model discovery: `GET /v1/models`
- Agent runs: `POST /v1/responses`

Traceframe sends no client `Authorization` header to this route. CC Switch owns its upstream credentials and injects them internally. Traceframe does not read the CC Switch database, configuration, keys, or tokens. If CC Switch advertises no models, Traceframe leaves the model field explicit rather than guessing an ID.

### Direct providers

For OpenAI and other providers, enter an endpoint, model, and API key. The endpoint and selected model are saved as local preferences. The API key remains in renderer memory for the current application process and must be entered again after restart; it is excluded from local storage, Traceframe's SQLite database, and the repository.

The OpenAI settings list the current general-purpose text and code models from the [official model catalog](https://developers.openai.com/api/docs/models). A successful authenticated `GET /v1/models` replaces that reference list with the models actually advertised to the current connection. Catalog presence is not proof of account access.

## Workspace

Every main surface is a dock tab and can be rearranged and resized. Layouts persist locally and can be reset or changed from Appearance settings.

| Area | Current behavior |
| --- | --- |
| Sessions | Create, search, archive, restore, and persist task history |
| Conversation | Stream model output, send with Enter, add a line with Shift+Enter, queue and remove follow-up turns during a run, and stop active runs |
| Code | Preview, edit, save, revert, detect conflicting external changes, and follow agent edits to the current file and changed line range without discarding local drafts |
| Diff and Git | Inspect staged or unstaged changes and switch existing local branches |
| Output and trace | Inspect ordered model, tool, file-change, usage, completion, failure, and cancellation events |
| Context and memory | Review deterministic session summaries and manage session, project, and global memory records |
| Agents | Follow the root agent and real delegated specialists, including their task, parent, model, progress state, and result |

Filesystem operations stay behind the Rust host. The workspace bridge rejects traversal, symlink escapes, binary files, oversized writes, truncated previews, and stale overwrites. Agent commands run without a shell, with a program allowlist, output limits, and timeouts, but they still run with the desktop user's operating-system permissions. A permission broker and stronger process isolation remain roadmap work.

## Development

Requirements: Node.js 22+, Rust 1.84+, and the platform prerequisites for Tauri 2.

```bash
npm ci
npm run desktop:dev
```

Required checks:

```bash
npm run build
npm test
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run desktop:build
```

`npm run dev` starts a browser renderer with representative fallback data. Use `npm run desktop:dev` for native workspace, persistence, Git, editor, and runtime behavior.

See [runtime architecture](docs/runtime-architecture.md), [roadmap](ROADMAP.md), [security policy](SECURITY.md), and [contributing guide](CONTRIBUTING.md).

## Design credit

The interface was reviewed with [unslop](https://github.com/heydamir/unslop), created by Damir Sokolovsky, under CC BY 4.0.
