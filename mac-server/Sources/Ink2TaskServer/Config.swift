import Foundation

/// Config lives in the user's home directory, separate from the repo, so
/// it survives a `git pull` / rebuild. Mirrors the plugin's own config
/// file conceptually (list name + port), just on the other side of the
/// LAN connection.
struct ServerConfig: Codable {
    var listName: String
    var port: UInt16

    static let `default` = ServerConfig(listName: "Supernote", port: 8942)
}

enum ConfigStore {
    static let directory = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".ink2task", isDirectory: true)
    static let file = directory.appendingPathComponent("config.json")

    static func load() -> ServerConfig {
        guard let data = try? Data(contentsOf: file),
              let config = try? JSONDecoder().decode(ServerConfig.self, from: data)
        else {
            let config = ServerConfig.default
            save(config)
            print("No config found -- wrote a default one to \(file.path)")
            print("Edit it to set your Reminders list name, then restart.")
            return config
        }
        return config
    }

    static func save(_ config: ServerConfig) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(config) {
            try? data.write(to: file)
        }
    }
}
