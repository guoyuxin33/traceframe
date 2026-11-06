# Contributing

Traceframe is an early desktop developer preview. Keep changes focused, preserve the native security boundary, and distinguish working behavior from representative UI in code and documentation.

## Development setup

Requirements:

- Node.js 22 or newer
- Rust 1.84 or newer
- Tauri 2 platform prerequisites
- macOS for the current desktop bundle and native CI path

Install dependencies and start the desktop app:

```bash
npm ci
npm run desktop:dev
```

`npm run dev` runs only the renderer with fallback data. Use the desktop command when changing workspace, Git, persistence, or runtime behavior.

## Required checks

Run the checks that CI applies before opening a pull request:

```bash
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

On macOS, also verify the native bundle when the change affects desktop integration:

```bash
npm run desktop:build
```

## Pull requests

- Explain the user-visible behavior and the verification performed.
- Add focused tests when changing Rust host boundaries, persistence, runtime parsing, or Git behavior.
- Do not commit API keys, tokens, local databases, build output, or workspace-specific paths.
- Keep planned capabilities clearly labeled; a rendered control is not evidence that its backend exists.
- Preserve unrelated work already present in the branch.
