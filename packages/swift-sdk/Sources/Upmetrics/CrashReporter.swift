import Foundation
#if canImport(Darwin)
import Darwin
#endif

// Crash capture. A crashing process cannot send (it's dying), so handlers write
// a record to disk; `Upmetrics.start` reads + sends it on the next launch.
//
// The signal handler is ASYNC-SIGNAL-SAFE: it touches only globals set up at
// install time and calls only safe C functions (backtrace, write, fsync, signal,
// raise). No Swift allocation, no Foundation, no malloc in the handler.

private let monitoredSignals: [Int32] = [SIGSEGV, SIGABRT, SIGTRAP, SIGILL, SIGBUS, SIGFPE]
private let backtraceCapacity: Int32 = 128
private let backtraceBuffer = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: Int(backtraceCapacity))
private var crashFileDescriptor: Int32 = -1
private var previousExceptionHandler: (@convention(c) (NSException) -> Void)?

/// @convention(c) so it can be a raw signal handler. Async-signal-safe.
private func handleSignal(_ sig: Int32) {
    let n = backtrace(backtraceBuffer, backtraceCapacity)
    if crashFileDescriptor >= 0 {
        var s = sig
        var count = n
        _ = withUnsafeBytes(of: &s) { write(crashFileDescriptor, $0.baseAddress, 4) }
        _ = withUnsafeBytes(of: &count) { write(crashFileDescriptor, $0.baseAddress, 4) }
        write(crashFileDescriptor, backtraceBuffer, Int(n) * MemoryLayout<UnsafeMutableRawPointer?>.size)
        fsync(crashFileDescriptor)
    }
    // Restore the default action and re-raise so the process dies exactly as it
    // would have (OS crash report still fires; a supervisor still sees the crash).
    signal(sig, SIG_DFL)
    raise(sig)
}

private func handleException(_ exception: NSException) {
    CrashStore.recordException(exception)
    previousExceptionHandler?(exception)
}

enum CrashReporter {
    private static var installed = false

    static func install() {
        guard !installed else { return }
        installed = true

        // Snapshot loaded images now (same address space as any future crash) so
        // raw signal addresses can be symbolicated server-side later.
        CrashStore.snapshotImages()

        // Pre-open the crash file and prime backtrace's lazy dyld binding, so the
        // signal handler itself allocates nothing.
        let path = Paths.crashes.appendingPathComponent("latest.signal").path
        crashFileDescriptor = open(path, O_CREAT | O_WRONLY | O_TRUNC, 0o644)
        _ = backtrace(backtraceBuffer, backtraceCapacity)

        previousExceptionHandler = NSGetUncaughtExceptionHandler()
        NSSetUncaughtExceptionHandler(handleException)

        for sig in monitoredSignals { signal(sig, handleSignal) }
    }
}
