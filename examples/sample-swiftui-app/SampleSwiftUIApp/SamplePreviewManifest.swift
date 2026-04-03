import Foundation
import SwiftPreviewKit

enum SamplePreviewManifest {
    static func load() -> PreviewManifest {
        guard let url = Bundle.main.url(forResource: "PreviewManifest", withExtension: "json") else {
            fatalError("Missing PreviewManifest.json in sample app bundle.")
        }

        do {
            let data = try Data(contentsOf: url)
            return try JSONDecoder().decode(PreviewManifest.self, from: data)
        } catch {
            fatalError("Failed to load sample preview manifest: \(error)")
        }
    }
}
