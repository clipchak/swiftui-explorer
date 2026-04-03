# Host Integration Contract

The host app should eventually expose two things:

1. a registry of previewable targets,
2. a debug-only entrypoint that can render one target with one fixture and one environment.

## Current Contract

`SwiftPreviewKit` currently defines:

- `PreviewTarget`
- `PreviewDescriptor`
- `PreviewFixture`
- `PreviewEnvironment`
- `PreviewContext`
- `PreviewRegistry`
- `StaticPreviewRegistry`

This is enough to standardize both discovery metadata and a host-side rendering closure for each registered preview target.

## Next Contract Expansion

The next iteration should add:

- fixture payload hooks for mock state injection,
- environment application helpers,
- a debug host app adapter that can select a target by identifier,
- and a serialization layer so the runtime can request targets and fixtures over a stable API.
