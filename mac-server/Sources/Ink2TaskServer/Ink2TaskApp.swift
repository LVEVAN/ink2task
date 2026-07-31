import Foundation

@main
struct Ink2TaskServer {
    static func main() async {
        let config = ConfigStore.load()
        let reminders = ReminderStore()

        print("Ink2Task server starting…")
        print("Requesting Reminders access (approve the system prompt if you see one)…")
        do {
            try await reminders.requestAccess()
        } catch {
            print("Could not get Reminders access: \(error)")
            exit(1)
        }
        print("Reminders access OK. Syncing list: \"\(config.listName)\"")

        let server = HTTPServer(port: config.port) { request in
            await route(request, config: config, reminders: reminders)
        }

        do {
            try server.start()
        } catch {
            print("Failed to start server on port \(config.port): \(error)")
            exit(1)
        }

        let host = LocalNetwork.likelyLANAddress() ?? "<could not detect LAN IP>"
        print("")
        print("Listening on http://\(host):\(config.port)")
        print("Put that address into Ink2Task's settings on your Supernote.")
        print("Config file: \(ConfigStore.file.path)")
        print("Press Ctrl+C to stop.")

        // Keep the process alive; NWListener runs on its own queue.
        while true {
            try? await Task.sleep(nanoseconds: 3_600_000_000_000)
        }
    }

    static func route(_ request: HTTPRequest, config: ServerConfig, reminders: ReminderStore) async -> HTTPResponse {
        switch (request.method, request.path) {
        case ("GET", "/health"):
            return .json(["ok": true, "app": "ink2task", "backend": "apple", "listName": config.listName])

        case ("GET", "/lists"):
            return .json(["lists": reminders.listNames()])

        case ("GET", "/reminders"):
            let listName = request.query["list"] ?? config.listName
            do {
                let items = try await reminders.incompleteReminders(listName: listName)
                let encoded = items.map { reminder -> [String: Any] in
                    var dict: [String: Any] = ["id": reminder.id, "title": reminder.title]
                    if let due = reminder.due { dict["due"] = due }
                    if let priority = reminder.priority { dict["priority"] = priority }
                    return dict
                }
                return .json(["reminders": encoded])
            } catch {
                print("GET /reminders failed: \(error)")
                return .json(["error": "\(error)"], status: 500)
            }

        case ("POST", "/reminders"):
            guard
                let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let title = (json["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                !title.isEmpty
            else {
                return .json(["error": "Expected JSON body: {\"title\": \"...\"}"], status: 400)
            }
            let listName = (json["list"] as? String) ?? config.listName
            do {
                let id = try reminders.create(title: title, listName: listName)
                return .json(["id": id, "title": title])
            } catch {
                print("POST /reminders failed: \(error)")
                return .json(["error": "\(error)"], status: 500)
            }

        case ("POST", "/complete"):
            guard
                let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let ids = json["ids"] as? [String]
            else {
                return .json(["error": "Expected JSON body: {\"ids\": [\"...\"]}"], status: 400)
            }

            var completed: [String] = []
            var failed: [String] = []
            for id in ids {
                do {
                    try reminders.complete(id: id)
                    completed.append(id)
                } catch {
                    print("Failed to complete \(id): \(error)")
                    failed.append(id)
                }
            }
            return .json(["completed": completed, "failed": failed])

        case ("POST", "/uncomplete"):
            guard
                let json = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
                let ids = json["ids"] as? [String]
            else {
                return .json(["error": "Expected JSON body: {\"ids\": [\"...\"]}"], status: 400)
            }

            var uncompleted: [String] = []
            var failed: [String] = []
            for id in ids {
                do {
                    try reminders.uncomplete(id: id)
                    uncompleted.append(id)
                } catch {
                    print("Failed to uncomplete \(id): \(error)")
                    failed.append(id)
                }
            }
            return .json(["uncompleted": uncompleted, "failed": failed])

        default:
            return .text("Not found", status: 404)
        }
    }
}
