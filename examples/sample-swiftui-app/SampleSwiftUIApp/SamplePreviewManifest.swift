import Foundation
import SwiftPreviewKit

enum SamplePreviewManifest {
    static func generate(from registry: some SwiftPreviewKit.PreviewRegistry) -> PreviewManifest {
        registry.manifest(appName: SamplePreviewRegistry.appName, scheme: SamplePreviewRegistry.scheme)
    }

    static func write(_ manifest: PreviewManifest, to outputPath: String) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]

        guard let data = try? encoder.encode(manifest) else {
            return
        }

        let url = URL(fileURLWithPath: outputPath)
        try? FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try? data.write(to: url)
    }
}
