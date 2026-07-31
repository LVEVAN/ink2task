import EventKit
import Foundation

enum ReminderError: Error, CustomStringConvertible {
    case accessDenied
    case listNotFound(String)
    case notAReminder(String)
    case saveFailed(String)

    var description: String {
        switch self {
        case .accessDenied:
            return "Reminders access was denied. Grant it in System Settings > Privacy & Security > Reminders."
        case .listNotFound(let name):
            return "No Reminders list named \"\(name)\" was found."
        case .notAReminder(let id):
            return "No reminder with id \(id) was found."
        case .saveFailed(let reason):
            return "Failed to save: \(reason)"
        }
    }
}

struct RemoteReminder: Codable {
    let id: String
    let title: String
    /// Due date, or nil if the reminder has none. "YYYY-MM-DD" when it's a
    /// date only, or "YYYY-MM-DDTHH:MM" when the reminder also has a time.
    /// Sent as plain components to sidestep timezone drift from a Date round-trip.
    let due: String?
    /// This reminder's priority tier, 1 (most urgent) to 3, or nil if unset
    /// ("None"). EKReminder.priority is a raw 0-9 scale that Reminders.app's
    /// own picker collapses into four buttons -- None(0), High(1-4), Medium(5),
    /// Low(6-9) -- mapped here to nil/1/2/3. There's no Apple equivalent of a
    /// 4th tier (that's Todoist-only; see the plugin's RemoteReminder.priority
    /// comment for the full picture across backends).
    let priority: Int?
}

/// Thin async wrapper around EventKit. One `EKEventStore` for the whole
/// server's lifetime, matching Apple's guidance to reuse a single store
/// rather than creating one per call.
final class ReminderStore {
    private let store = EKEventStore()

    /// Prompts for access the first time this runs; on later runs this
    /// resolves immediately once the user has granted it once.
    func requestAccess() async throws {
        if #available(macOS 14.0, *) {
            let granted = try await store.requestFullAccessToReminders()
            guard granted else { throw ReminderError.accessDenied }
        } else {
            let granted: Bool = try await withCheckedThrowingContinuation { continuation in
                store.requestAccess(to: .reminder) { granted, error in
                    if let error = error {
                        continuation.resume(throwing: error)
                    } else {
                        continuation.resume(returning: granted)
                    }
                }
            }
            guard granted else { throw ReminderError.accessDenied }
        }
    }

    /// Titles of every Reminders list, for the plugin's list picker.
    func listNames() -> [String] {
        return store.calendars(for: .reminder)
            .map { $0.title }
            .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    private func calendar(named name: String) throws -> EKCalendar {
        let lists = store.calendars(for: .reminder)
        guard let match = lists.first(where: { $0.title == name }) else {
            throw ReminderError.listNotFound(name)
        }
        return match
    }

    /// Incomplete reminders in the named list, oldest-created first so the
    /// on-device order stays stable between fetches.
    func incompleteReminders(listName: String) async throws -> [RemoteReminder] {
        let list = try calendar(named: listName)
        let predicate = store.predicateForIncompleteReminders(
            withDueDateStarting: nil,
            ending: nil,
            calendars: [list]
        )

        let reminders: [EKReminder] = await withCheckedContinuation { continuation in
            store.fetchReminders(matching: predicate) { result in
                continuation.resume(returning: result ?? [])
            }
        }

        return reminders
            .sorted { ($0.creationDate ?? .distantPast) < ($1.creationDate ?? .distantPast) }
            .map { reminder in
                RemoteReminder(
                    id: reminder.calendarItemIdentifier,
                    title: reminder.title ?? "(untitled)",
                    due: Self.dueString(for: reminder),
                    priority: Self.priorityTier(reminder.priority)
                )
            }
    }

    /// Maps EKReminder's raw 0-9 priority to the plugin's 3-tier scale, or nil
    /// for "None" (0). See RemoteReminder.priority for why there's no tier 4.
    private static func priorityTier(_ raw: Int) -> Int? {
        switch raw {
        case 1...4: return 1  // "High"
        case 5: return 2      // "Medium"
        case 6...9: return 3  // "Low"
        default: return nil   // 0 = "None"
        }
    }

    /// The date shown on a reminder, as "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".
    ///
    /// A reminder can carry its date two ways: a formal *due date*
    /// (`dueDateComponents`) or a *remind-me* date, which Apple stores as an
    /// alarm. The Reminders app shows both the same way, so we check the due
    /// date first and fall back to the earliest alarm -- otherwise every
    /// "remind me at 2pm" reminder would look dateless to the plugin.
    private static func dueString(for reminder: EKReminder) -> String? {
        let calendar = Calendar.current
        var comps: DateComponents?
        var hasTime = false

        if let c = reminder.dueDateComponents {
            comps = c
            hasTime = c.hour != nil && c.minute != nil
        } else if let date = reminder.alarms?.compactMap({ $0.absoluteDate }).min() {
            comps = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
            hasTime = true // an alarm always carries a time
        }

        guard let c = comps, let y = c.year, let m = c.month, let d = c.day else {
            return nil
        }
        var s = String(format: "%04d-%02d-%02d", y, m, d)
        if hasTime, let h = c.hour, let min = c.minute {
            s += String(format: "T%02d:%02d", h, min)
        }
        return s
    }

    /// Creates a new reminder with the given title in the named list, and
    /// returns its identifier -- used by the handwritten-capture flow.
    func create(title: String, listName: String) throws -> String {
        let list = try calendar(named: listName)
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = list
        do {
            try store.save(reminder, commit: true)
            return reminder.calendarItemIdentifier
        } catch {
            throw ReminderError.saveFailed(error.localizedDescription)
        }
    }

    /// Reverses a completion -- used by the plugin's un-check flow.
    func uncomplete(id: String) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw ReminderError.notAReminder(id)
        }
        reminder.isCompleted = false
        reminder.completionDate = nil
        do {
            try store.save(reminder, commit: true)
        } catch {
            throw ReminderError.saveFailed(error.localizedDescription)
        }
    }

    /// Marks a reminder completed by its calendarItemIdentifier.
    /// Returns normally on success, throws otherwise -- the caller
    /// collects successes/failures across a batch.
    func complete(id: String) throws {
        guard let reminder = store.calendarItem(withIdentifier: id) as? EKReminder else {
            throw ReminderError.notAReminder(id)
        }
        reminder.isCompleted = true
        reminder.completionDate = Date()
        do {
            try store.save(reminder, commit: true)
        } catch {
            throw ReminderError.saveFailed(error.localizedDescription)
        }
    }
}
