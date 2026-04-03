// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SwiftPreviewKit",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "SwiftPreviewKit",
            targets: ["SwiftPreviewKit"]
        )
    ],
    targets: [
        .target(
            name: "SwiftPreviewKit"
        ),
        .testTarget(
            name: "SwiftPreviewKitTests",
            dependencies: ["SwiftPreviewKit"]
        )
    ]
)
