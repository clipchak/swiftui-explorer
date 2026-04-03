# Runtime Protocol

The extension talks to the local runtime over `localhost`. The protocol should stay small and explicit so the editor layer and orchestration layer can version independently.

## Versioning

- Base path: `/api/v1`
- Health check: `/health`
- Every JSON response includes a top-level `version`

## Initial Endpoints

### `GET /health`

Returns runtime liveness and basic metadata:

```json
{
  "version": "0.1.0",
  "status": "ok",
  "service": "swiftui-explorer-preview-cli"
}
```

### `GET /api/v1/workspace/inspect`

Returns the runtime's view of the current workspace:

```json
{
  "version": "0.1.0",
  "workspaceRoot": "/path/to/repo",
  "hasPackageSwift": false,
  "hasXcodeProject": false,
  "hasWorkspace": false,
  "hasXcodeGenSpec": true,
  "suggestedNextAction": "Generate the sample app project with XcodeGen, then point the runtime at that app target."
}
```

### `GET /api/v1/config`

Returns the active host app configuration the runtime will use for discovery, build, install, and launch:

```json
{
  "version": "0.1.0",
  "usingDefault": true,
  "appRoot": "/path/to/app",
  "projectPath": "/path/to/App.xcodeproj",
  "workspacePath": null,
  "xcodeGenSpecPath": "/path/to/project.yml",
  "scheme": "App",
  "manifestPath": "/path/to/PreviewManifest.json",
  "bundleIdentifier": "com.example.app"
}
```

### `POST /api/v1/config`

Persists a host app configuration. The request must include:

- `appRoot`
- exactly one of `projectPath` or `workspacePath`
- `scheme`
- `bundleIdentifier`
- optional `xcodeGenSpecPath`
- optional `manifestPath` (auto-detected if omitted — the runtime scans the app root for `PreviewManifest.json` and checks `.swiftui-explorer/manifests/<scheme>.json`)

### `GET /api/v1/auto-refresh`

Returns whether runtime-owned auto-refresh is currently enabled.

### `POST /api/v1/auto-refresh`

Updates the persisted runtime-owned auto-refresh state.

## Manifest Discovery

The runtime auto-detects the preview manifest rather than requiring users to locate it manually.

Search order:

1. **Cached manifest**: `.swiftui-explorer/manifests/<scheme>.json` — written by the host app on each launch via the `SWIFTUI_EXPLORER_MANIFEST_OUTPUT` environment variable.
2. **Source-tree scan**: walks the app root (up to 4 levels) looking for a file named `PreviewManifest.json`.
3. **Fallback**: uses the cached path from step 1 (will be created on the next build+launch cycle).

Host apps that integrate `SwiftPreviewKit` should define preview targets in their `PreviewRegistry` implementation and generate the manifest from the registry (see `SamplePreviewManifest` in the sample app). The runtime passes `SWIFTUI_EXPLORER_MANIFEST_OUTPUT` as a `SIMCTL_CHILD_` environment variable at launch, so the app writes the manifest to the expected cache location automatically.

## Expected Near-Term Additions

- `POST /api/v1/session/start`
- `POST /api/v1/capture/snapshot`

## Design Constraints

- The extension should never shell out to `xcodebuild` directly.
- The runtime should own all simulator process control.
- Host apps should only need to implement the Swift preview registry contract, not editor-specific code.
- Users should never need to manually author or select `PreviewManifest.json` — the manifest is generated from Swift code and auto-detected by the runtime.
