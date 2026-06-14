import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Gathers device / OS / app context. Cross-platform (works on macOS for tests
/// and CI; richer device naming on iOS via UIDevice).
enum DeviceInfo {
    static func contexts() -> Contexts {
        Contexts(
            device: DeviceContext(model: hardwareModel(), arch: arch()),
            os: OSContext(name: osName(), version: osVersion()),
            app: AppContext(
                app_version: bundle("CFBundleShortVersionString"),
                app_build: bundle("CFBundleVersion"),
                app_identifier: Bundle.main.bundleIdentifier))
    }

    /// hw.machine = the hardware identifier (e.g. "iPhone16,2" / "arm64").
    static func hardwareModel() -> String? { sysctl("hw.machine") }

    private static func arch() -> String? {
        #if arch(arm64)
        return "arm64"
        #elseif arch(x86_64)
        return "x86_64"
        #else
        return nil
        #endif
    }

    private static func osName() -> String {
        #if os(iOS)
        return "iOS"
        #elseif os(macOS)
        return "macOS"
        #elseif os(tvOS)
        return "tvOS"
        #elseif os(watchOS)
        return "watchOS"
        #else
        return "unknown"
        #endif
    }

    private static func osVersion() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private static func bundle(_ key: String) -> String? {
        Bundle.main.object(forInfoDictionaryKey: key) as? String
    }

    private static func sysctl(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buf = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buf, &size, nil, 0) == 0 else { return nil }
        return String(cString: buf)
    }
}
