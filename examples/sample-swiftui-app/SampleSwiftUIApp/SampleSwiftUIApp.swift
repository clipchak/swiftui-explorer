import SwiftUI

@main
struct SampleSwiftUIApp: App {
    var body: some Scene {
        WindowGroup {
            PreviewHostRootView(registry: SamplePreviewRegistry())
        }
    }
}
