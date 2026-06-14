import XCTest
@testable import Upmetrics

final class UpmetricsTests: XCTestCase {
    let fm = FileManager.default

    override func setUp() { wipeCrashDir() }
    override func tearDown() { wipeCrashDir() }
    private func wipeCrashDir() {
        try? fm.removeItem(at: Paths.crashes)
        try? fm.removeItem(at: Paths.queue)
    }

    // MARK: DSN

    func testDSNParsesTheUpmetricsContract() {
        let dsn = DSN("https://abc123@upmetrics.org/buddy")
        XCTAssertEqual(dsn?.endpoint, "https://upmetrics.org")
        XCTAssertEqual(dsn?.publicKey, "abc123")
        XCTAssertEqual(dsn?.projectId, "buddy")
        XCTAssertEqual(dsn?.envelopeURL?.absoluteString,
                       "https://upmetrics.org/api/buddy/envelope/?sentry_key=abc123")
    }

    func testDSNKeepsAPort() {
        XCTAssertEqual(DSN("http://k@localhost:3017/p")?.endpoint, "http://localhost:3017")
    }

    func testDSNRejectsMalformed() {
        XCTAssertNil(DSN("https://upmetrics.org/buddy"))   // no public key
        XCTAssertNil(DSN("https://abc123@upmetrics.org/"))  // no project id
        XCTAssertNil(DSN("not a url"))
    }

    // MARK: envelope

    func testEnvelopeIsThreeSentryLines() throws {
        var ev = SentryEvent(event_id: "e1", timestamp: 1.5, level: "error")
        ev.message = "boom"
        let body = try Envelope.body(for: ev)
        let lines = String(decoding: body, as: UTF8.self).split(separator: "\n", omittingEmptySubsequences: false)
        XCTAssertEqual(lines.count, 3)
        let header = try JSONSerialization.jsonObject(with: Data(lines[0].utf8)) as! [String: Any]
        XCTAssertEqual(header["event_id"] as? String, "e1")
        XCTAssertNotNil(header["sent_at"])
        XCTAssertEqual(String(lines[1]), "{\"type\":\"event\"}")
        let payload = try JSONSerialization.jsonObject(with: Data(lines[2].utf8)) as! [String: Any]
        XCTAssertEqual(payload["platform"] as? String, "cocoa")
        XCTAssertEqual(payload["message"] as? String, "boom")
        XCTAssertEqual((payload["sdk"] as? [String: Any])?["name"] as? String, "upmetrics-swift")
    }

    func testEventOmitsNilFields() throws {
        let ev = SentryEvent(event_id: "e2", timestamp: 1, level: "info") // environment/release nil
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(ev)) as! [String: Any]
        XCTAssertNil(json["environment"])
        XCTAssertNil(json["exception"])
        XCTAssertNil(json["tags"])  // empty tags omitted
    }

    // MARK: scrub

    func testScrubMasksPII() {
        XCTAssertEqual(Scrub.mask("mail me at cb@webhouse.dk now"), "mail me at [email] now")
        XCTAssertEqual(Scrub.mask("cpr 010203-1234"), "cpr [cpr]")
        XCTAssertEqual(Scrub.mask("ring +45 12345678"), "ring [phone]")
        XCTAssertEqual(Scrub.mask("nothing here"), "nothing here")
    }

    // MARK: crash parsing

    func testDrainParsesASignalCrash() throws {
        try fm.createDirectory(at: Paths.crashes, withIntermediateDirectories: true)
        // images.json (snapshot the install would have written)
        let images: [[String: Any]] = [[
            "image_addr": "0x100000000", "code_file": "/buddy.app/buddy", "debug_id": UUID().uuidString,
        ]]
        try JSONSerialization.data(withJSONObject: images)
            .write(to: Paths.crashes.appendingPathComponent("images.json"))
        // a .signal record: SIGSEGV + 2 addresses (Int32 sig, Int32 count, UInt×2)
        var data = Data()
        var sig: Int32 = SIGSEGV; var count: Int32 = 2
        withUnsafeBytes(of: &sig) { data.append(contentsOf: $0) }
        withUnsafeBytes(of: &count) { data.append(contentsOf: $0) }
        for var a: UInt in [0x100001000, 0x100002000] {
            withUnsafeBytes(of: &a) { data.append(contentsOf: $0) }
        }
        try data.write(to: Paths.crashes.appendingPathComponent("c.signal"))

        let events = CrashStore.drainPending(environment: "production", release: "1.4.0")
        XCTAssertEqual(events.count, 1)
        let exc = try XCTUnwrap(events.first?.exception?.values.first)
        XCTAssertEqual(exc.type, "SIGSEGV")
        XCTAssertEqual(exc.stacktrace?.frames.count, 2)
        XCTAssertEqual(exc.stacktrace?.frames.first?.instruction_addr?.hasPrefix("0x"), true)
        XCTAssertEqual(events.first?.debug_meta?.images.count, 1)
        XCTAssertEqual(events.first?.release, "1.4.0")
        // record consumed
        XCTAssertFalse(fm.fileExists(atPath: Paths.crashes.appendingPathComponent("c.signal").path))
    }

    // MARK: live integration (skipped unless UPMETRICS_TEST_DSN is set)

    func testLiveIngestWhenConfigured() throws {
        guard let dsn = ProcessInfo.processInfo.environment["UPMETRICS_TEST_DSN"], !dsn.isEmpty else {
            throw XCTSkip("set UPMETRICS_TEST_DSN to run the live integration test")
        }
        Upmetrics.start(dsn: dsn, environment: "swift-sdk-test", release: "itest")
        Upmetrics.setTag("probe", "unit")
        XCTAssertNotNil(Upmetrics.capture(message: "upmetrics-swift live unit ping", level: "info"))
        struct DemoError: Error, CustomStringConvertible { let description = "demo failure from swift unit" }
        Upmetrics.capture(DemoError())
        Upmetrics.flush(timeout: 8)
    }

    func testDrainParsesAnNSException() throws {
        try fm.createDirectory(at: Paths.crashes, withIntermediateDirectories: true)
        let record: [String: Any] = [
            "kind": "nsexception", "type": "NSRangeException",
            "value": "index 5 beyond bounds", "frames": ["0 buddy 0x1 foo", "1 buddy 0x2 bar"],
        ]
        try JSONSerialization.data(withJSONObject: record)
            .write(to: Paths.crashes.appendingPathComponent("e.nsexc"))

        let events = CrashStore.drainPending(environment: nil, release: nil)
        let exc = try XCTUnwrap(events.first?.exception?.values.first)
        XCTAssertEqual(exc.type, "NSRangeException")
        XCTAssertEqual(exc.value, "index 5 beyond bounds")
        XCTAssertEqual(exc.stacktrace?.frames.count, 2)
    }
}
