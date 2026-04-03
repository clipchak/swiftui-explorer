import SwiftUI
import SwiftPreviewKit

struct SamplePreviewRegistry: SwiftPreviewKit.PreviewRegistry {
    private let manifest = SamplePreviewManifest.load()

    func allPreviews() -> [PreviewTarget] {
        manifest.targets.map { descriptor in
            makePreviewTarget(from: descriptor)
        }
    }

    private func makePreviewTarget(from descriptor: PreviewDescriptor) -> PreviewTarget {
        switch descriptor.id {
        case "welcome-card":
            return PreviewTarget(descriptor: descriptor) { context in
                WelcomeCardView(model: WelcomeCardModel.fixture(named: context.fixture?.id))
            }
        case "account-summary":
            return PreviewTarget(descriptor: descriptor) { context in
                AccountSummaryView(model: AccountSummaryModel.fixture(named: context.fixture?.id))
            }
        default:
            return PreviewTarget(descriptor: descriptor) { _ in
                ContentUnavailableView(
                    "Unknown Preview Target",
                    systemImage: "questionmark.square.dashed",
                    description: Text("No renderer is registered for \(descriptor.id).")
                )
            }
        }
    }
}
