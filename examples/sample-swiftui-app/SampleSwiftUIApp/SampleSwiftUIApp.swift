import SwiftUI

@main
struct SampleSwiftUIApp: App {
    private let launchSelection = PreviewLaunchSelection.fromProcessEnvironment()

    init() {
        let registry = SamplePreviewRegistry()
        let manifest = SamplePreviewManifest.generate(from: registry)

        if let outputPath = ProcessInfo.processInfo.environment["SWIFTUI_EXPLORER_MANIFEST_OUTPUT"] {
            SamplePreviewManifest.write(manifest, to: outputPath)
        }
    }

    var body: some Scene {
        WindowGroup {
            PreviewHostRootView(
                registry: SamplePreviewRegistry(),
                launchSelection: launchSelection
            )
        }
    }
}
