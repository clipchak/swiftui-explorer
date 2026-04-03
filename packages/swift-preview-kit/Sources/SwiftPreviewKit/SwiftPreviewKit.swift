import Foundation

public struct PreviewFixture: Hashable, Sendable {
    public let id: String
    public let displayName: String

    public init(id: String, displayName: String) {
        self.id = id
        self.displayName = displayName
    }
}

public struct PreviewEnvironment: Hashable, Sendable {
    public enum ColorScheme: String, Hashable, Sendable {
        case light
        case dark
    }

    public let colorScheme: ColorScheme
    public let localeIdentifier: String
    public let dynamicTypeSize: String

    public init(
        colorScheme: ColorScheme = .light,
        localeIdentifier: String = "en_US",
        dynamicTypeSize: String = "large"
    ) {
        self.colorScheme = colorScheme
        self.localeIdentifier = localeIdentifier
        self.dynamicTypeSize = dynamicTypeSize
    }
}

public struct PreviewDescriptor: Hashable, Sendable {
    public let id: String
    public let displayName: String
    public let fixtures: [PreviewFixture]
    public let supportedEnvironments: [PreviewEnvironment]

    public init(
        id: String,
        displayName: String,
        fixtures: [PreviewFixture] = [],
        supportedEnvironments: [PreviewEnvironment] = [.init()]
    ) {
        self.id = id
        self.displayName = displayName
        self.fixtures = fixtures
        self.supportedEnvironments = supportedEnvironments
    }
}

public protocol PreviewRegistry {
    func allPreviews() -> [PreviewDescriptor]
}

public struct StaticPreviewRegistry: PreviewRegistry, Sendable {
    private let previews: [PreviewDescriptor]

    public init(previews: [PreviewDescriptor]) {
        self.previews = previews
    }

    public func allPreviews() -> [PreviewDescriptor] {
        previews
    }
}
