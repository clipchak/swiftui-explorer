# Architecture

`swiftui-explorer` is intentionally split into three layers so rendering and simulator orchestration do not live inside the editor extension.

## Layers

### `packages/vscode-extension`

Owns editor UX:

- commands,
- sidebar and panel UI,
- prompt entry,
- workspace settings,
- and communication with the local runtime.

### `packages/preview-cli`

Owns local machine orchestration:

- workspace inspection,
- Xcode project and scheme discovery,
- simulator boot/install/launch,
- preview refresh scheduling,
- screenshot or frame capture,
- and a localhost API for the extension.

### `packages/swift-preview-kit`

Owns host app integration:

- a registry of previewable targets,
- fixtures,
- environment options,
- and debug-only host wiring for rendering a selected target.

## First Vertical Slice

The first buildable slice in this repo is narrower than the full plan:

1. the extension can open a panel,
2. the panel can query a local runtime,
3. the runtime can report workspace state,
4. and the Swift package can model registered preview targets.

That gives us a stable place to add real preview launching next without having to rework package boundaries.
