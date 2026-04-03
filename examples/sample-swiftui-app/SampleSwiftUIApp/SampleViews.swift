import SwiftUI

struct WelcomeCardView: View {
    let model: WelcomeCardModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(model.eyebrow.uppercased())
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(model.title)
                .font(.largeTitle.weight(.bold))

            Text(model.subtitle)
                .font(.body)
                .foregroundStyle(.secondary)

            Button("Continue") {}
                .buttonStyle(.borderedProminent)
                .tint(model.accent)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(model.accent.opacity(0.14))
        )
    }
}

struct AccountSummaryView: View {
    let model: AccountSummaryModel

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Weekly Summary")
                        .font(.headline)

                    Text(model.ownerName)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.title2)
                    .foregroundStyle(model.accent)
            }

            Text(model.balanceLabel)
                .font(.system(size: 34, weight: .bold, design: .rounded))

            HStack {
                Label(model.status, systemImage: "checkmark.circle.fill")
                Spacer()
                Text(model.trend)
            }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(.secondary)
        }
        .padding(24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(.quaternary.opacity(0.4))
        )
    }
}
