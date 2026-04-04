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
2. **Generate stubs** — Run `SwiftUI Explorer: Generate Preview Adapters` (or click "Generate Stubs" in the panel). The extension scans your project for SwiftUI views and creates:
   - Bootstrap wiring in your `@main ... : App` file (registry, launch selection, manifest generation).
   - A separate `SwiftUIExplorerPreviewAdapters.swift` file with one adapter stub per view.
3. **AI-generate adapters** — Click "Generate With AI" or run `SwiftUI Explorer: Generate Adapters With AI`. The editor's built-in model reads each view's source code and generates a first-pass adapter implementation. The generated code is validated with an Xcode build check, and successfully generated targets are marked as configured in the manifest.
4. **Review and refine** — AI-generated adapters are written into `SwiftUIExplorerPreviewAdapters.swift`. Review them, adjust initializers or fixture data as needed, then open the targets in Simulator.
5. **Manual fallback** — If AI generation can't handle a view (complex DI, navigation context, etc.), fill in the adapter manually:

```swift
static func renderSettingsView(_ context: SwiftUIExplorerPreviewContext) -> some View {
    SettingsView(store: SettingsStore.preview)
}
```

6. **Rerunning setup** — Rerunning "Generate Stubs" regenerates the scaffold wiring but preserves existing adapter implementations. Only new views get placeholder stubs appended.
7. **Advanced** — For a cleaner long-term setup, move adapters into a dedicated SwiftPreviewKit-based registry similar to the sample app in `examples/sample-swiftui-app`.

## MVP Direction

V1 stays focused on `SwiftUI` only:

1. register previewable screens and fixtures from a host app,
2. render them through a local runtime and simulator loop,
3. refresh quickly after changes,
4. use AI to generate preview adapters for discovered views,
5. then layer AI-assisted concept generation on top of that same runtime.
