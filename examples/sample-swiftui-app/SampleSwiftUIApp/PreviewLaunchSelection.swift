import Foundation

struct PreviewLaunchSelection {
    let targetID: String?
    let fixtureID: String?
    let environmentID: String?

    static func fromProcessEnvironment() -> PreviewLaunchSelection {
        let environment = ProcessInfo.processInfo.environment

        return PreviewLaunchSelection(
            targetID: environment["SWIFTUI_EXPLORER_TARGET_ID"],
            fixtureID: environment["SWIFTUI_EXPLORER_FIXTURE_ID"],
            environmentID: environment["SWIFTUI_EXPLORER_ENVIRONMENT_ID"]
        )
    }
}
