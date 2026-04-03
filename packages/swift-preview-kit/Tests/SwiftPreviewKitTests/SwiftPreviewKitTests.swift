import SwiftUI
import Testing
@testable import SwiftPreviewKit

@Test func staticRegistryReturnsRegisteredPreviews() async throws {
    let registry = StaticPreviewRegistry(
        previews: [
            PreviewTarget(
                id: "home-screen",
                displayName: "Home Screen",
                fixtures: [
                    PreviewFixture(id: "signed-out", displayName: "Signed Out"),
                    PreviewFixture(id: "signed-in", displayName: "Signed In")
                ],
                supportedEnvironments: [.defaultLight, .defaultDark]
            ) { _ in
                EmptyView()
            }
        ]
    )

    let previews = registry.allPreviews()

    #expect(previews.count == 1)
    #expect(previews[0].descriptor.id == "home-screen")
    #expect(previews[0].descriptor.fixtures.count == 2)
    #expect(registry.descriptors().count == 1)
}
