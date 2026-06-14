import Foundation

let sdkName = "upmetrics-swift"
let sdkVersion = "0.1.0"

/// A Sentry-format event. Field names match what the Upmetrics ingest already
/// accepts from @upmetrics/sdk. Optionals are omitted (encodeIfPresent) so the
/// payload is clean — same as JSON.stringify dropping `undefined`.
struct SentryEvent: Encodable {
    var event_id: String
    var timestamp: Double
    var platform: String = "cocoa"
    var level: String
    var environment: String?
    var release: String?
    var sdk = SDKInfo()
    var message: String?
    var exception: ExceptionContainer?
    var tags: [String: String]?
    var user: [String: String]?
    var contexts: Contexts?
    var breadcrumbs: [Breadcrumb]?
    var debug_meta: DebugMeta?

    enum CodingKeys: String, CodingKey {
        case event_id, timestamp, platform, level, environment, release, sdk
        case message, exception, tags, user, contexts, breadcrumbs, debug_meta
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(event_id, forKey: .event_id)
        try c.encode(timestamp, forKey: .timestamp)
        try c.encode(platform, forKey: .platform)
        try c.encode(level, forKey: .level)
        try c.encodeIfPresent(environment, forKey: .environment)
        try c.encodeIfPresent(release, forKey: .release)
        try c.encode(sdk, forKey: .sdk)
        try c.encodeIfPresent(message, forKey: .message)
        try c.encodeIfPresent(exception, forKey: .exception)
        try c.encodeIfPresent(tags?.isEmpty == true ? nil : tags, forKey: .tags)
        try c.encodeIfPresent(user, forKey: .user)
        try c.encodeIfPresent(contexts, forKey: .contexts)
        try c.encodeIfPresent(breadcrumbs?.isEmpty == true ? nil : breadcrumbs, forKey: .breadcrumbs)
        try c.encodeIfPresent(debug_meta, forKey: .debug_meta)
    }
}

struct SDKInfo: Encodable {
    var name = sdkName
    var version = sdkVersion
}

struct ExceptionContainer: Encodable {
    var values: [SentryException]
}

struct SentryException: Encodable {
    var type: String
    var value: String
    var stacktrace: Stacktrace?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(value, forKey: .value)
        try c.encodeIfPresent(stacktrace, forKey: .stacktrace)
    }
    enum CodingKeys: String, CodingKey { case type, value, stacktrace }
}

struct Stacktrace: Encodable {
    var frames: [Frame]
}

/// Sentry orders frames oldest-first (the crashing frame last).
struct Frame: Encodable {
    var function: String?
    var package: String?
    var instruction_addr: String?
    var image_addr: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(function, forKey: .function)
        try c.encodeIfPresent(package, forKey: .package)
        try c.encodeIfPresent(instruction_addr, forKey: .instruction_addr)
        try c.encodeIfPresent(image_addr, forKey: .image_addr)
    }
    enum CodingKeys: String, CodingKey { case function, package, instruction_addr, image_addr }
}

struct Breadcrumb: Encodable {
    var timestamp: Double
    var category: String?
    var message: String?
    var level: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(timestamp, forKey: .timestamp)
        try c.encodeIfPresent(category, forKey: .category)
        try c.encodeIfPresent(message, forKey: .message)
        try c.encodeIfPresent(level, forKey: .level)
    }
    enum CodingKeys: String, CodingKey { case timestamp, category, message, level }
}

struct Contexts: Encodable {
    var device: DeviceContext?
    var os: OSContext?
    var app: AppContext?
}
struct DeviceContext: Encodable { var model: String?; var arch: String? }
struct OSContext: Encodable { var name: String?; var version: String? }
struct AppContext: Encodable { var app_version: String?; var app_build: String?; var app_identifier: String? }

/// Captured binary images (load address + UUID + name) so a crash's raw frame
/// addresses can be symbolicated server-side against the dSYM later (F020.2).
struct DebugMeta: Encodable {
    var images: [DebugImage]
}
struct DebugImage: Encodable {
    var type = "macho"
    var image_addr: String
    var code_file: String?
    var debug_id: String?

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(type, forKey: .type)
        try c.encode(image_addr, forKey: .image_addr)
        try c.encodeIfPresent(code_file, forKey: .code_file)
        try c.encodeIfPresent(debug_id, forKey: .debug_id)
    }
    enum CodingKeys: String, CodingKey { case type, image_addr, code_file, debug_id }
}

enum Envelope {
    /// The 3-line Sentry envelope body: header / item-header / event. Identical
    /// framing to @upmetrics/sdk `send()`.
    static func body(for event: SentryEvent, sentAt: Date = Date()) throws -> Data {
        let enc = JSONEncoder()
        enc.outputFormatting = [.withoutEscapingSlashes]
        let header = try JSONSerialization.data(
            withJSONObject: ["event_id": event.event_id, "sent_at": iso8601(sentAt)])
        let itemHeader = try JSONSerialization.data(withJSONObject: ["type": "event"])
        let payload = try enc.encode(event)
        var out = Data()
        out.append(header); out.append(0x0A)
        out.append(itemHeader); out.append(0x0A)
        out.append(payload)
        return out
    }

    private static let isoFormatter: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static func iso8601(_ d: Date) -> String { isoFormatter.string(from: d) }
}
