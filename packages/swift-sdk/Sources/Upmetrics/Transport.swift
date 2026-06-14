import Foundation

/// Sends envelopes to the ingest endpoint with an on-disk retry queue. Every
/// event is written to disk first, then POSTed; a 2xx deletes it. So an event
/// captured just before termination (or offline) is retried on next `flush()`
/// (called from `Upmetrics.start`). Fire-and-forget: never throws into the host.
final class Transport {
    private let dsn: DSN
    private let queueDir: URL
    private let session: URLSession
    private let fm = FileManager.default

    init(dsn: DSN, queueDir: URL, session: URLSession = .shared) {
        self.dsn = dsn
        self.queueDir = queueDir
        self.session = session
        try? fm.createDirectory(at: queueDir, withIntermediateDirectories: true)
    }

    /// Persist + attempt send. Returns the file URL it was queued at (for tests).
    @discardableResult
    func send(_ event: SentryEvent) -> URL? {
        guard let body = try? Envelope.body(for: event) else { return nil }
        let file = queueDir.appendingPathComponent("\(event.event_id).envelope")
        do { try body.write(to: file) } catch { return nil }
        post(file: file, body: body, completion: nil)
        return file
    }

    /// Re-attempt every queued envelope. If `wait` > 0, block up to that many
    /// seconds (used by tests + app-background flush); otherwise fire-and-forget.
    func flush(wait: TimeInterval = 0) {
        guard let files = try? fm.contentsOfDirectory(
            at: queueDir, includingPropertiesForKeys: nil) else { return }
        let pending = files.filter { $0.pathExtension == "envelope" }
        guard !pending.isEmpty else { return }
        let group = wait > 0 ? DispatchGroup() : nil
        for file in pending {
            guard let body = try? Data(contentsOf: file) else { continue }
            group?.enter()
            post(file: file, body: body) { group?.leave() }
        }
        if let group, wait > 0 { _ = group.wait(timeout: .now() + wait) }
    }

    private func post(file: URL, body: Data, completion: (() -> Void)?) {
        guard let url = dsn.envelopeURL else { completion?(); return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-sentry-envelope", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let fm = self.fm
        session.dataTask(with: req) { _, resp, _ in
            if let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode) {
                try? fm.removeItem(at: file) // delivered → drop from the queue
            }
            completion?()
        }.resume()
    }
}
