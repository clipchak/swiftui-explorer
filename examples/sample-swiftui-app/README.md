# Sample SwiftUI App

This example is the in-repo reference host app for `swiftui-explorer`.

It demonstrates:

- embedding `SwiftPreviewKit` into a real SwiftUI app,
- registering previewable targets and fixtures,
- and rendering those targets through a simple debug host screen.

## Generate The Xcode Project

The sample app uses `XcodeGen` so we can keep the repo source-first instead of checking in a hand-edited `.pbxproj`.

```bash
brew install xcodegen
cd examples/sample-swiftui-app
xcodegen generate
open SampleSwiftUIApp.xcodeproj
```

## Current Scope

The app is intentionally simple. It is a local host for exercising:

- preview registry metadata,
- fixture switching,
- environment switching,
- and future runtime-driven preview selection.
