# Host Integration Contract

The host app should eventually expose two things:

1. a registry of previewable targets,
2. a debug-only entrypoint that can render one target with one fixture and one environment.

## Current Contract

`SwiftPreviewKit` currently defines metadata types:

- `PreviewDescriptor`
- `PreviewFixture`
- `PreviewEnvironment`
- `PreviewRegistry`
- `StaticPreviewRegistry`

This is enough to start standardizing discovery before we wire in actual SwiftUI rendering closures.

## Next Contract Expansion

The next iteration should add:

- a renderable target type that maps a descriptor to a SwiftUI view,
- fixture payload hooks for mock state injection,
- environment application helpers,
- and a debug host app adapter that can select a target by identifier.
