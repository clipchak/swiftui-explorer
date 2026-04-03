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

## Expected Near-Term Additions

- `POST /api/v1/session/start`
- `POST /api/v1/preview/open`
- `POST /api/v1/preview/refresh`
- `GET /api/v1/targets`
- `GET /api/v1/fixtures`
- `POST /api/v1/capture/snapshot`

## Design Constraints

- The extension should never shell out to `xcodebuild` directly.
- The runtime should own all simulator process control.
- Host apps should only need to implement the Swift preview registry contract, not editor-specific code.
