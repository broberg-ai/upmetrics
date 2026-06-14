import Foundation

/// PII scrubbing — port of @upmetrics/sdk `scrub.ts`. On by default: mask
/// email / Danish CPR / phone in any free-text string before send. Applied to
/// the user-controlled strings in an event (message, exception value, breadcrumb
/// + frame text). Same markers as the JS SDK so scrubbing is consistent fleet-wide.
enum Scrub {
    // Case-insensitive email. NSRegularExpression has no /i literal, so options.
    private static let email = try! NSRegularExpression(
        pattern: "[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}", options: [.caseInsensitive])
    private static let cpr = try! NSRegularExpression(pattern: "\\b\\d{6}-?\\d{4}\\b")
    // +45 optional, 8 digits, not bordered by another digit. (?<!\d)…(?!\d)
    private static let phone = try! NSRegularExpression(
        pattern: "(?<!\\d)(?:\\+45[\\s-]?)?\\d{8}(?!\\d)")

    static func mask(_ s: String) -> String {
        var out = s
        out = replace(email, in: out, with: "[email]")
        out = replace(cpr, in: out, with: "[cpr]")
        out = replace(phone, in: out, with: "[phone]")
        return out
    }

    /// Masks an optional string in place (nil passes through).
    static func mask(_ s: String?) -> String? { s.map(mask) }

    private static func replace(_ re: NSRegularExpression, in s: String, with t: String) -> String {
        let range = NSRange(s.startIndex..<s.endIndex, in: s)
        return re.stringByReplacingMatches(in: s, options: [], range: range, withTemplate: t)
    }
}
