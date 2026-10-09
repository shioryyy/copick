import Foundation

// 配置：~/Library/Application Support/Copick/config.json，仅本地读写。
struct Config: Codable {
    var mode = "blacklist"
    var list: [String] = []
    var paused = false
}

final class ConfigStore {
    private let url: URL
    private(set) var value = Config()

    init() {
        let dir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Copick")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        url = dir.appendingPathComponent("config.json")
        if let d = try? Data(contentsOf: url), let c = try? JSONDecoder().decode(Config.self, from: d) { value = c }
    }

    func update(_ f: (inout Config) -> Void) {
        f(&value)
        let enc = JSONEncoder(); enc.outputFormatting = .prettyPrinted
        try? enc.encode(value).write(to: url)
    }
}
