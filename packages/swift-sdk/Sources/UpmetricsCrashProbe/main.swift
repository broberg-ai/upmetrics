import Foundation
import Upmetrics

// Verification harness for the crash path (not shipped to apps). Two runs:
//   swift run UpmetricsCrashProbe crash   → arms handlers, abort()s → writes latest.signal, dies
//   swift run UpmetricsCrashProbe         → start() drains that record + sends it, then flushes
// Needs UPMETRICS_TEST_DSN; the sent event is then confirmed in the prod DB.

guard let dsn = ProcessInfo.processInfo.environment["UPMETRICS_TEST_DSN"], !dsn.isEmpty else {
    FileHandle.standardError.write(Data("UPMETRICS_TEST_DSN not set\n".utf8))
    exit(2)
}
let release = ProcessInfo.processInfo.environment["UPMETRICS_TEST_RELEASE"] ?? "crashprobe"
Upmetrics.start(dsn: dsn, environment: "swift-sdk-test", release: release)

if CommandLine.arguments.contains("crash") {
    print("crashprobe: handlers armed — raising SIGABRT now")
    fflush(stdout)
    abort() // SIGABRT → async-signal-safe handler writes latest.signal, then dies
} else {
    // start() already drained the prior run's crash + queued it; flush to deliver.
    Upmetrics.flush(timeout: 10)
    print("crashprobe: flushed pending crash(es)")
    exit(0)
}
