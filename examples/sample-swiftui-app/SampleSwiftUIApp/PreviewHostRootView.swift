import SwiftUI
import SwiftPreviewKit

struct PreviewHostRootView: View {
    private let previews: [PreviewTarget]

    @State private var selectedPreviewID: String
    @State private var selectedFixtureID: String
    @State private var selectedEnvironmentID: String

    init(
        registry: some SwiftPreviewKit.PreviewRegistry,
        launchSelection: PreviewLaunchSelection = PreviewLaunchSelection(
            targetID: nil,
            fixtureID: nil,
            environmentID: nil
        )
    ) {
        let previews = registry.allPreviews()
        self.previews = previews

        let initialPreview = previews.first(where: { $0.id == launchSelection.targetID }) ?? previews.first
        let initialFixtureID = initialPreview?.descriptor.fixtures.first(where: { $0.id == launchSelection.fixtureID })?.id
            ?? initialPreview?.descriptor.fixtures.first?.id
            ?? ""
        let initialEnvironmentID = initialPreview?.descriptor.supportedEnvironments.first(where: { $0.id == launchSelection.environmentID })?.id
            ?? initialPreview?.descriptor.supportedEnvironments.first?.id
            ?? PreviewEnvironment.defaultLight.id

        _selectedPreviewID = State(initialValue: initialPreview?.descriptor.id ?? "")
        _selectedFixtureID = State(initialValue: initialFixtureID)
        _selectedEnvironmentID = State(initialValue: initialEnvironmentID)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                configurationSection
                Divider()
                renderedPreview
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
            .padding()
            .navigationTitle("SwiftUI Explorer Sample")
            .onChange(of: selectedPreviewID) { _, _ in
                syncSelectionToCurrentPreview()
            }
        }
    }

    private var selectedPreview: PreviewTarget? {
        previews.first { $0.id == selectedPreviewID }
    }

    private var selectedEnvironment: PreviewEnvironment {
        selectedPreview?.descriptor.supportedEnvironments.first(where: { $0.id == selectedEnvironmentID })
            ?? selectedPreview?.descriptor.supportedEnvironments.first
            ?? .defaultLight
    }

    @ViewBuilder
    private var configurationSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Preview Host")
                .font(.headline)

            Picker("Target", selection: $selectedPreviewID) {
                ForEach(previews) { preview in
                    Text(preview.descriptor.displayName).tag(preview.id)
                }
            }
            .pickerStyle(.menu)

            if let preview = selectedPreview, !preview.descriptor.fixtures.isEmpty {
                Picker("Fixture", selection: $selectedFixtureID) {
                    ForEach(preview.descriptor.fixtures) { fixture in
                        Text(fixture.displayName).tag(fixture.id)
                    }
                }
                .pickerStyle(.segmented)
            }

            if let preview = selectedPreview {
                Picker("Environment", selection: $selectedEnvironmentID) {
                    ForEach(preview.descriptor.supportedEnvironments) { environment in
                        Text(environment.displayName).tag(environment.id)
                    }
                }
                .pickerStyle(.segmented)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var renderedPreview: some View {
        if let preview = selectedPreview {
            ScrollView {
                preview.makeView(
                    fixtureID: selectedFixtureID.isEmpty ? nil : selectedFixtureID,
                    environment: selectedEnvironment
                )
                .padding(.vertical, 24)
            }
        } else {
            ContentUnavailableView(
                "No Preview Targets",
                systemImage: "rectangle.on.rectangle.slash",
                description: Text("Register a preview target in the sample registry to render it here.")
            )
        }
    }

    private func syncSelectionToCurrentPreview() {
        guard let preview = selectedPreview else {
            selectedFixtureID = ""
            selectedEnvironmentID = PreviewEnvironment.defaultLight.id
            return
        }

        selectedFixtureID = preview.descriptor.fixtures.first?.id ?? ""
        selectedEnvironmentID = preview.descriptor.supportedEnvironments.first?.id ?? PreviewEnvironment.defaultLight.id
    }
}
