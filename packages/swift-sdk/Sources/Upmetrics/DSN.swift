import Foundation

/// A parsed Upmetrics DSN: `https://<publicKey>@<host>/<projectId>`.
/// Mirrors the @upmetrics/sdk `parseDsn` contract exactly so a Swift client
/// reports to the same ingest endpoint as every other fleet surface.
struct DSN: Equatable {
    let endpoint: String   // scheme://host[:port]
    let publicKey: String
    let projectId: String

    init?(_ raw: String) {
        guard let u = URLComponents(string: raw),
              let scheme = u.scheme, !scheme.isEmpty,
              let host = u.host, !host.isEmpty,
              let key = u.user, !key.isEmpty
        else { return nil }
        let port = u.port.map { ":\($0)" } ?? ""
        let pid = u.path.hasPrefix("/") ? String(u.path.dropFirst()) : u.path
        guard !pid.isEmpty else { return nil }
        self.endpoint = "\(scheme)://\(host)\(port)"
        self.publicKey = key
        self.projectId = pid
    }

    /// The Sentry-envelope ingest URL the JS SDK uses:
    /// `{endpoint}/api/{projectId}/envelope/?sentry_key={publicKey}`.
    var envelopeURL: URL? {
        URL(string: "\(endpoint)/api/\(projectId)/envelope/?sentry_key=\(publicKey)")
    }
}
