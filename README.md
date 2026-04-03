# swiftui-explorer

Preview, compare, and eventually AI-generate SwiftUI screens directly inside Cursor or VS Code using your real app components and fixtures.

## Monorepo Layout

- `packages/vscode-extension`: editor UX layer for Cursor and VS Code
- `packages/preview-cli`: local runtime for build, simulator, and preview orchestration
- `packages/swift-preview-kit`: host-side Swift package embedded into debug builds
- `examples/sample-swiftui-app`: future integration example app
- `docs/`: architecture and protocol notes

## Current Status

The repo is bootstrapped around the first MVP slice:

- a TypeScript workspace root,
- a minimal extension that opens a SwiftUI Explorer panel,
- a local runtime with health and workspace inspection endpoints,
- and a Swift package that defines the first preview registration contract.

## First Build Steps

```bash
npm install
npm run build
```

For the Swift package:

```bash
cd packages/swift-preview-kit
swift test
```

## MVP Direction

V1 stays focused on `SwiftUI` only:

1. register previewable screens and fixtures from a host app,
2. render them through a local runtime and simulator loop,
3. refresh quickly after changes,
4. then layer AI-assisted concept generation on top of that same runtime.
