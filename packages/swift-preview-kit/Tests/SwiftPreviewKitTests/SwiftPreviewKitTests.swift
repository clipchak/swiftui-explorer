import Testing
@testable import SwiftPreviewKit

@Test func staticRegistryReturnsRegisteredPreviews() async throws {
    let registry = StaticPreviewRegistry(
        previews: [
            PreviewDescriptor(
                id: "home-screen",
                displayName: "Home Screen",
                fixtures: [
                    PreviewFixture(id: "signed-out", displayName: "Signed Out"),
                    PreviewFixture(id: "signed-in", displayName: "Signed In")
                ]
            )
        ]
    )

    let previews = registry.allPreviews()

    #expect(previews.count == 1)
    #expect(previews[0].id == "home-screen")
    #expect(previews[0].fixtures.count == 2)
}
