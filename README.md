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

1. **Configure** — Use `Configure Host App` in the explorer panel. Provide the app root, project/workspace, scheme, and bundle ID.
2. **Generate adapters** — Run `SwiftUI Explorer: Generate Preview Adapters` (or click "Set Up Previews" in the panel). The extension scans your project for SwiftUI views and generates preview adapter stubs into your `@main ... : App` file.
3. **Verify** — Open any generated target in Simulator. You'll see a placeholder confirming the wiring works.
4. **Fill in adapters** — Each adapter is a static function in `SwiftUIExplorerPreviewAdapters`. Replace the `ContentUnavailableView` placeholder with your real view initializer:

```swift
// Before (generated stub):
static func renderSettingsView(_ context: SwiftUIExplorerPreviewContext) -> some View {
    ContentUnavailableView("Settings View", systemImage: "puzzlepiece.extension", ...)
}

// After (your real view):
static func renderSettingsView(_ context: SwiftUIExplorerPreviewContext) -> some View {
    SettingsView(store: SettingsStore.preview)
}
```

5. **Update status** — Mark the target's status as `"configured"` in the manifest (`.swiftui-explorer/manifests/<scheme>.json`) to remove the stub badge in the panel.
6. **Advanced** — For a cleaner long-term setup, move adapters into a dedicated SwiftPreviewKit-based registry similar to the sample app in `examples/sample-swiftui-app`.

## MVP Direction

V1 stays focused on `SwiftUI` only:

1. register previewable screens and fixtures from a host app,
2. render them through a local runtime and simulator loop,
3. refresh quickly after changes,
4. then layer AI-assisted concept generation on top of that same runtime.
