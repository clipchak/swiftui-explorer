import SwiftUI
import SwiftPreviewKit

struct SamplePreviewRegistry: SwiftPreviewKit.PreviewRegistry {
    static let appName = "SampleSwiftUIApp"
    static let scheme = "SampleSwiftUIApp"

    func allPreviews() -> [PreviewTarget] {
        [
            PreviewTarget(
                id: "welcome-card",
                displayName: "Welcome Card",
                fixtures: [
                    PreviewFixture(id: "onboarding", displayName: "Onboarding"),
                    PreviewFixture(id: "team-space", displayName: "Team Space"),
                ],
                supportedEnvironments: [
                    .defaultLight,
                    .defaultDark,
                    PreviewEnvironment(
                        id: "accessibility-dark",
                        displayName: "Dark + A11y",
                        colorScheme: .dark,
                        dynamicTypeSize: .accessibility1
                    ),
                ]
            ) { context in
                WelcomeCardView(model: WelcomeCardModel.fixture(named: context.fixture?.id))
            },
            PreviewTarget(
                id: "account-summary",
                displayName: "Account Summary",
                fixtures: [
                    PreviewFixture(id: "healthy-budget", displayName: "Healthy Budget"),
                    PreviewFixture(id: "tight-budget", displayName: "Tight Budget"),
                ]
            ) { context in
                AccountSummaryView(model: AccountSummaryModel.fixture(named: context.fixture?.id))
            },
        ]
    }
}
