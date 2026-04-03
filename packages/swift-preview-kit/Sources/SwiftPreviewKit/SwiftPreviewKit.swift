import Foundation
import SwiftUI

public struct PreviewFixture: Codable, Hashable, Sendable, Identifiable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

public struct PreviewEnvironment: Codable, Hashable, Sendable, Identifiable {
    public enum ColorScheme: String, Codable, Hashable, Sendable {
        case light
        case dark
    }

    public enum DynamicTypeSizeOption: String, Codable, Hashable, Sendable {
        case small
        case large
        case accessibility1
    }

    public let id: String
    public let displayName: String
    public let colorScheme: ColorScheme
    public let localeIdentifier: String
    public let dynamicTypeSize: DynamicTypeSizeOption

    public init(
        id: String,
        displayName: String,
        colorScheme: ColorScheme = .light,
        localeIdentifier: String = "en_US",
        dynamicTypeSize: DynamicTypeSizeOption = .large
    ) {
        self.id = id
        self.displayName = displayName
        self.colorScheme = colorScheme
        self.localeIdentifier = localeIdentifier
        self.dynamicTypeSize = dynamicTypeSize
    }

    public static let defaultLight = PreviewEnvironment(
        id: "light",
        displayName: "Light",
        colorScheme: .light
    )

    public static let defaultDark = PreviewEnvironment(
        id: "dark",
        displayName: "Dark",
        colorScheme: .dark
    )

    public static let defaults = [defaultLight, defaultDark]

    @MainActor
    public func apply<Content: View>(to content: Content) -> some View {
        content
            .environment(\.locale, Locale(identifier: localeIdentifier))
            .environment(\.dynamicTypeSize, swiftUIDynamicTypeSize)
            .preferredColorScheme(swiftUIColorScheme)
    }

    private var swiftUIColorScheme: SwiftUI.ColorScheme {
        switch colorScheme {
        case .light:
            return .light
        case .dark:
            return .dark
        }
    }

    private var swiftUIDynamicTypeSize: SwiftUI.DynamicTypeSize {
        switch dynamicTypeSize {
        case .small:
            return .small
        case .large:
            return .large
        case .accessibility1:
            return .accessibility1
        }
    }
}

public struct PreviewDescriptor: Codable, Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let fixtures: [PreviewFixture]
    public let supportedEnvironments: [PreviewEnvironment]

    public init(
        id: String,
        displayName: String,
        fixtures: [PreviewFixture] = [],
        supportedEnvironments: [PreviewEnvironment] = PreviewEnvironment.defaults
    ) {
        self.id = id
        self.displayName = displayName
        self.fixtures = fixtures
        self.supportedEnvironments = supportedEnvironments
    }
}

public struct PreviewManifest: Codable, Hashable, Sendable {
    public let appName: String
    public let scheme: String
    public let targets: [PreviewDescriptor]

    public init(appName: String, scheme: String, targets: [PreviewDescriptor]) {
        self.appName = appName
        self.scheme = scheme
        self.targets = targets
    }
}

public struct PreviewContext {
    public let fixture: PreviewFixture?
    public let environment: PreviewEnvironment

    public init(fixture: PreviewFixture?, environment: PreviewEnvironment) {
        self.fixture = fixture
        self.environment = environment
    }
}

public struct PreviewTarget: Identifiable {
    public let descriptor: PreviewDescriptor
    private let renderBody: @MainActor (PreviewContext) -> AnyView

    public var id: String {
        descriptor.id
    }

    public init<Content: View>(
        id: String,
        displayName: String,
        fixtures: [PreviewFixture] = [],
        supportedEnvironments: [PreviewEnvironment] = PreviewEnvironment.defaults,
        @ViewBuilder render: @escaping @MainActor (PreviewContext) -> Content
    ) {
        self.descriptor = PreviewDescriptor(
            id: id,
            displayName: displayName,
            fixtures: fixtures,
            supportedEnvironments: supportedEnvironments
        )
        self.renderBody = { context in
            AnyView(render(context))
        }
    }

    public init<Content: View>(
        descriptor: PreviewDescriptor,
        @ViewBuilder render: @escaping @MainActor (PreviewContext) -> Content
    ) {
        self.descriptor = descriptor
        self.renderBody = { context in
            AnyView(render(context))
        }
    }

    @MainActor
    public func makeView(
        fixtureID: String? = nil,
        environment: PreviewEnvironment? = nil
    ) -> some View {
        let selectedEnvironment = environment ?? descriptor.supportedEnvironments.first ?? .defaultLight
        let selectedFixture = descriptor.fixtures.first { $0.id == fixtureID } ?? descriptor.fixtures.first
        let context = PreviewContext(fixture: selectedFixture, environment: selectedEnvironment)

        return selectedEnvironment.apply(to: renderBody(context))
    }
}

public protocol PreviewRegistry {
    func allPreviews() -> [PreviewTarget]
}

public extension PreviewRegistry {
    func descriptors() -> [PreviewDescriptor] {
        allPreviews().map(\.descriptor)
    }

    func manifest(appName: String, scheme: String) -> PreviewManifest {
        PreviewManifest(
            appName: appName,
            scheme: scheme,
            targets: descriptors()
        )
    }

    func preview(withID id: String) -> PreviewTarget? {
        allPreviews().first { $0.id == id }
    }
}

public struct StaticPreviewRegistry: PreviewRegistry {
    private let previews: [PreviewTarget]

    public init(previews: [PreviewTarget]) {
        self.previews = previews
    }

    public func allPreviews() -> [PreviewTarget] {
        previews
    }
}
