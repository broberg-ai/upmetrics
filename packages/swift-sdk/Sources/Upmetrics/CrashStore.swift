import Foundation
import MachO

/// Persists crash records to disk (the crashing process is dying, so it can't
/// send) and turns the previous run's records into events on next launch.
///
/// Two record kinds:
///  • `.nsexc`  — an uncaught NSException. The handler runs with Foundation
///    available, so we save symbolicated frame strings directly.
///  • `.signal` — a fatal signal. Written by the async-signal-safe signal handler
///    as raw bytes (signal + backtrace addresses). Symbolication is server-side
///    (F020.2) using the binary-image list snapshotted at install.
enum CrashStore {
    // MARK: write (called from handlers / at install)

    /// Snapshot the loaded Mach-O images (base + slide + UUID + path) so a crash's
    /// raw addresses can be symbolicated later. Captured at install (same address
    /// space as the crash) and persisted next to the crash records.
    static func snapshotImages() {
        var images: [[String: Any]] = []
        for i in 0..<_dyld_image_count() {
            guard let header = _dyld_get_image_header(i),
                  let namePtr = _dyld_get_image_name(i) else { continue }
            let base = UInt(bitPattern: header)
            var dict: [String: Any] = [
                "image_addr": hex(base),
                "code_file": String(cString: namePtr),
            ]
            if let uuid = imageUUID(header) { dict["debug_id"] = uuid }
            images.append(dict)
        }
        try? FileManager.default.createDirectory(at: Paths.crashes, withIntermediateDirectories: true)
        if let data = try? JSONSerialization.data(withJSONObject: images) {
            try? data.write(to: Paths.crashes.appendingPathComponent("images.json"))
        }
    }

    /// Persist an uncaught NSException (handler context — Foundation is usable).
    static func recordException(_ exc: NSException) {
        let record: [String: Any] = [
            "kind": "nsexception",
            "type": exc.name.rawValue,
            "value": exc.reason ?? exc.name.rawValue,
            "frames": exc.callStackSymbols,
        ]
        try? FileManager.default.createDirectory(at: Paths.crashes, withIntermediateDirectories: true)
        guard let data = try? JSONSerialization.data(withJSONObject: record) else { return }
        try? data.write(to: Paths.crashes.appendingPathComponent("\(newEventId()).nsexc"))
    }

    // MARK: read (called from start())

    /// Build events from any persisted crashes, deleting each record as it's read.
    /// Each becomes a level=error exception event with the current scope's
    /// environment/release. Returns oldest-first.
    static func drainPending(environment: String?, release: String?) -> [SentryEvent] {
        let fm = FileManager.default
        guard let files = try? fm.contentsOfDirectory(at: Paths.crashes, includingPropertiesForKeys: nil)
        else { return [] }
        let images = loadImages()
        var events: [SentryEvent] = []
        for file in files.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
            switch file.pathExtension {
            case "nsexc":
                if let e = eventFromException(file, environment: environment, release: release) { events.append(e) }
                try? fm.removeItem(at: file)
            case "signal":
                if let e = eventFromSignal(file, images: images, environment: environment, release: release) { events.append(e) }
                try? fm.removeItem(at: file)
            default:
                break
            }
        }
        return events
    }

    // MARK: builders

    private static func eventFromException(_ file: URL, environment: String?, release: String?) -> SentryEvent? {
        guard let data = try? Data(contentsOf: file),
              let r = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let type = (r["type"] as? String) ?? "NSException"
        let value = (r["value"] as? String) ?? type
        // callStackSymbols are already symbolicated (captured in-process). Sentry
        // orders oldest-first → reverse the top-down call stack.
        let frames = ((r["frames"] as? [String]) ?? []).reversed().map { Frame(function: $0) }
        return crashEvent(type: type, value: value, frames: frames, images: nil,
                          environment: environment, release: release)
    }

    private static func eventFromSignal(_ file: URL, images: DebugMeta?, environment: String?, release: String?) -> SentryEvent? {
        guard let data = try? Data(contentsOf: file), data.count >= 8 else { return nil }
        let (signal, addrs) = data.withUnsafeBytes { raw -> (Int32, [UInt]) in
            let sig = raw.load(fromByteOffset: 0, as: Int32.self)
            let count = Int(raw.load(fromByteOffset: 4, as: Int32.self))
            var out = [UInt]()
            let stride = MemoryLayout<UInt>.size
            for i in 0..<count {
                let off = 8 + i * stride
                guard off + stride <= data.count else { break }
                out.append(raw.load(fromByteOffset: off, as: UInt.self))
            }
            return (sig, out)
        }
        // Oldest-first; raw addresses, server symbolicates against the images.
        let frames = addrs.reversed().map { Frame(instruction_addr: hex($0)) }
        return crashEvent(type: signalName(signal), value: "Fatal signal \(signalName(signal)) (\(signal))",
                          frames: frames, images: images, environment: environment, release: release)
    }

    private static func crashEvent(type: String, value: String, frames: [Frame], images: DebugMeta?,
                                   environment: String?, release: String?) -> SentryEvent {
        SentryEvent(
            event_id: newEventId(),
            timestamp: Date().timeIntervalSince1970,
            level: "error",
            environment: environment,
            release: release,
            exception: ExceptionContainer(values: [
                SentryException(type: type, value: Scrub.mask(value),
                                stacktrace: frames.isEmpty ? nil : Stacktrace(frames: frames))
            ]),
            contexts: DeviceInfo.contexts(),
            debug_meta: images)
    }

    private static func loadImages() -> DebugMeta? {
        let url = Paths.crashes.appendingPathComponent("images.json")
        guard let data = try? Data(contentsOf: url),
              let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else { return nil }
        let imgs = arr.map { DebugImage(image_addr: ($0["image_addr"] as? String) ?? "0x0",
                                        code_file: $0["code_file"] as? String,
                                        debug_id: $0["debug_id"] as? String) }
        return imgs.isEmpty ? nil : DebugMeta(images: imgs)
    }
}

func hex(_ v: UInt) -> String { "0x" + String(v, radix: 16) }

func signalName(_ s: Int32) -> String {
    switch s {
    case SIGSEGV: return "SIGSEGV"
    case SIGABRT: return "SIGABRT"
    case SIGTRAP: return "SIGTRAP"
    case SIGILL:  return "SIGILL"
    case SIGBUS:  return "SIGBUS"
    case SIGFPE:  return "SIGFPE"
    default:      return "SIG(\(s))"
    }
}

/// Parse the LC_UUID load command of a 64-bit Mach-O image → its debug UUID.
func imageUUID(_ header: UnsafePointer<mach_header>) -> String? {
    guard header.pointee.magic == MH_MAGIC_64 else { return nil }
    let h64 = UnsafeRawPointer(header).assumingMemoryBound(to: mach_header_64.self)
    var cursor = UnsafeRawPointer(h64).advanced(by: MemoryLayout<mach_header_64>.size)
    for _ in 0..<h64.pointee.ncmds {
        let lc = cursor.assumingMemoryBound(to: load_command.self)
        if lc.pointee.cmd == LC_UUID {
            let ucmd = cursor.assumingMemoryBound(to: uuid_command.self)
            return UUID(uuid: ucmd.pointee.uuid).uuidString
        }
        cursor = cursor.advanced(by: Int(lc.pointee.cmdsize))
    }
    return nil
}
