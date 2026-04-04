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
- a Swift package that defines the first preview registration contract,
- and an in-repo sample SwiftUI host app scaffolded under `examples/sample-swiftui-app`.

The runtime now defaults to the sample app, but the explorer can also be pointed at a custom host app project or workspace through the `Configure Host App` command or panel button. The preview manifest is auto-generated from the Swift `PreviewRegistry` and auto-detected by the runtime — users never need to manually author or select `PreviewManifest.json`.

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

## Integrating a Host App

1. Use `Configure Host App` in the explorer panel — you only need to provide the app root, project/workspace, scheme, and bundle ID.
2. If your app has no preview targets yet, run `SwiftUI Explorer: Set Up Previews For This App` or use the panel button. The extension scans for SwiftUI views and scaffolds starter preview support directly into your `@main ... : App` file.
3. Open the generated placeholder targets in Simulator to confirm the integration is working.
4. Replace the generated placeholder renderers with real view initializers and fixtures as you refine the integration.
5. If you want a cleaner long-term setup, you can later move the generated support into a dedicated SwiftPreviewKit-based registry similar to the sample app.

## MVP Direction

V1 stays focused on `SwiftUI` only:

1. register previewable screens and fixtures from a host app,
2. render them through a local runtime and simulator loop,
3. refresh quickly after changes,
4. then layer AI-assisted concept generation on top of that same runtime.
