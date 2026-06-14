// swift-tools-version:5.9
import PackageDescription

// upmetrics-swift — native error + crash capture for iOS/macOS Swift apps.
// Sends the same Sentry-format envelope to the same Upmetrics ingest endpoint as
// @upmetrics/sdk (JS), so native crashes land in the same fleet dashboard.
// Public DSN only — no secret/cost key (F020).
let package = Package(
    name: "Upmetrics",
    platforms: [.iOS(.v13), .macOS(.v11)],
    products: [
        .library(name: "Upmetrics", targets: ["Upmetrics"]),
    ],
    targets: [
        .target(name: "Upmetrics"),
        // Verification-only: drives a real crash + flush against a live DSN
        // (see docs/features/F020-native-swift-sdk.md verification plan).
        .executableTarget(name: "UpmetricsCrashProbe", dependencies: ["Upmetrics"]),
        .testTarget(name: "UpmetricsTests", dependencies: ["Upmetrics"]),
    ]
)
