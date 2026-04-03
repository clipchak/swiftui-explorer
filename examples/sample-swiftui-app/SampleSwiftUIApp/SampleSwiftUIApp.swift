import SwiftUI

@main
struct SampleSwiftUIApp: App {
    private let launchSelection = PreviewLaunchSelection.fromProcessEnvironment()

    var body: some Scene {
        WindowGroup {
            PreviewHostRootView(
                registry: SamplePreviewRegistry(),
                launchSelection: launchSelection
            )
        }
    }
}
