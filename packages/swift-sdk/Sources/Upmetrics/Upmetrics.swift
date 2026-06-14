import Foundation

/// Upmetrics native SDK — error + crash capture for Swift apps. Public DSN only;
/// there is no secret/cost path (cost is measured server-side, fleet rule, F020).
///
///     Upmetrics.start(dsn: "https://<key>@upmetrics.org/<project>",
///                     environment: "production", release: "1.4.0")
///     Upmetrics.capture(someError)
///
/// All capture is fire-and-forget — telemetry must never throw into the host app.
public enum Upmetrics {
    private static let lock = NSLock()
    private static var dsn: DSN?
    private static var environment: String?
    private static var release: String?
    private static var transport: Transport?
    private static var user: [String: String]?
    private static var tags: [String: String] = [:]
    private static var breadcrumbs: [Breadcrumb] = []
    private static var started = false

    /// Initialise the SDK. Flushes any crash from the previous run + any queued
    /// events, installs the crash handlers, and emits one startup event so the
    /// surface + its SDK version show in the dashboard even if it never errors.
    public static func start(dsn dsnString: String, environment: String? = nil, release: String? = nil) {
        guard let parsed = DSN(dsnString) else {
            NSLog("[upmetrics] invalid DSN — not started")
            return
        }
        lock.lock()
        guard !started else { lock.unlock(); return }
        started = true
        self.dsn = parsed
        self.environment = environment
        self.release = release
        let tx = Transport(dsn: parsed, queueDir: Paths.queue)
        self.transport = tx
        lock.unlock()

        // 1) Send any crash recorded by the previous (now-dead) process.
        for event in CrashStore.drainPending(environment: environment, release: release) {
            tx.send(event)
        }
        // 2) Retry anything left in the queue (offline / killed mid-send).
        tx.flush()
        // 3) Arm crash capture for this process.
        CrashReporter.install()
        // 4) One startup message → surface + SDK version land from boot (info → not an error).
        capture(message: "upmetrics: sdk initialised", level: "info")
    }

    /// Block up to `timeout`s while the on-disk queue drains. Call on app-background
    /// to push anything captured late in the session (also used by the test suite).
    public static func flush(timeout: TimeInterval = 3) {
        lock.lock(); let tx = transport; lock.unlock()
        tx?.flush(wait: timeout)
    }

    public static func setUser(_ u: [String: String]?) { lock.lock(); user = u; lock.unlock() }
    public static func setTag(_ key: String, _ value: String) { lock.lock(); tags[key] = value; lock.unlock() }

    public static func addBreadcrumb(category: String? = nil, message: String? = nil, level: String? = nil) {
        lock.lock()
        breadcrumbs.append(Breadcrumb(timestamp: Date().timeIntervalSince1970,
                                      category: category, message: Scrub.mask(message), level: level))
        if breadcrumbs.count > 50 { breadcrumbs.removeFirst() }
        lock.unlock()
    }

    /// Capture an error/exception. Returns the event id (nil if not started).
    @discardableResult
    public static func capture(_ error: Error) -> String? {
        // type = the concrete error type (good grouping key); value = its
        // description (enum case / NSError detail).
        let errorType = String(describing: type(of: error))
        let value = String(describing: error)
        let exc = SentryException(type: errorType.isEmpty ? "Error" : errorType,
                                  value: Scrub.mask(value), stacktrace: nil)
        var event = baseEvent(level: "error")
        event.exception = ExceptionContainer(values: [exc])
        return send(event)
    }

    @discardableResult
    public static func capture(message: String, level: String = "info") -> String? {
        var event = baseEvent(level: level)
        event.message = Scrub.mask(message)
        return send(event)
    }

    // MARK: - internal

    static func baseEvent(level: String) -> SentryEvent {
        lock.lock(); defer { lock.unlock() }
        return SentryEvent(
            event_id: newEventId(),
            timestamp: Date().timeIntervalSince1970,
            level: level,
            environment: environment,
            release: release,
            tags: tags,
            user: user,
            contexts: DeviceInfo.contexts(),
            breadcrumbs: breadcrumbs.isEmpty ? nil : breadcrumbs)
    }

    @discardableResult
    static func send(_ event: SentryEvent) -> String? {
        lock.lock(); let tx = transport; lock.unlock()
        guard let tx else { NSLog("[upmetrics] not started; call start() first"); return nil }
        tx.send(event)
        return event.event_id
    }
}

/// UUID without dashes — matches the @upmetrics/sdk event_id shape.
func newEventId() -> String { UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased() }

/// Durable on-disk locations. Application Support (not Caches) so a recorded
/// crash survives until the next launch can send it.
enum Paths {
    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("upmetrics", isDirectory: true)
    }
    static var queue: URL { root.appendingPathComponent("queue", isDirectory: true) }
    static var crashes: URL { root.appendingPathComponent("crashes", isDirectory: true) }
}
