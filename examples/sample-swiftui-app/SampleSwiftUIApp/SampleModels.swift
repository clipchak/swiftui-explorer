import Foundation
import SwiftUI

struct WelcomeCardModel {
    let eyebrow: String
    let title: String
    let subtitle: String
    let accent: Color

    static func fixture(named fixtureID: String?) -> WelcomeCardModel {
        switch fixtureID {
        case "team-space":
            return WelcomeCardModel(
                eyebrow: "Shared workspace",
                title: "Review product concepts together",
                subtitle: "Compare multiple SwiftUI directions without leaving your editor workflow.",
                accent: .purple
            )
        default:
            return WelcomeCardModel(
                eyebrow: "New project",
                title: "Ship a polished onboarding flow",
                subtitle: "Preview fixtures, themes, and states quickly while you iterate on real app code.",
                accent: .blue
            )
        }
    }
}

struct AccountSummaryModel {
    let ownerName: String
    let balanceLabel: String
    let status: String
    let trend: String
    let accent: Color

    static func fixture(named fixtureID: String?) -> AccountSummaryModel {
        switch fixtureID {
        case "tight-budget":
            return AccountSummaryModel(
                ownerName: "Taylor",
                balanceLabel: "$184 left this week",
                status: "Close to budget",
                trend: "-12% vs last week",
                accent: .orange
            )
        default:
            return AccountSummaryModel(
                ownerName: "Jordan",
                balanceLabel: "$1,240 available",
                status: "Healthy budget",
                trend: "+8% saved this month",
                accent: .green
            )
        }
    }
}
