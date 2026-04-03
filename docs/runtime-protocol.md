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
- `manifestPath`
- `bundleIdentifier`
- optional `xcodeGenSpecPath`

### `GET /api/v1/auto-refresh`

Returns whether runtime-owned auto-refresh is currently enabled.

### `POST /api/v1/auto-refresh`

Updates the persisted runtime-owned auto-refresh state.

## Expected Near-Term Additions

- `POST /api/v1/session/start`
- `POST /api/v1/preview/open`
- `POST /api/v1/preview/refresh`
- `GET /api/v1/targets`
- `POST /api/v1/capture/snapshot`

## Design Constraints

- The extension should never shell out to `xcodebuild` directly.
- The runtime should own all simulator process control.
- Host apps should only need to implement the Swift preview registry contract, not editor-specific code.
