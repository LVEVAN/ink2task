// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "Ink2TaskServer",
    platforms: [.macOS(.v13)],
    targets: [
        // No external dependencies on purpose: EventKit and Network are
        // both system frameworks, so this builds offline with just Xcode's
        // command line tools -- no SPM registry fetch required.
        .executableTarget(
            name: "Ink2TaskServer",
            path: "Sources/Ink2TaskServer"
        )
    ]
)
