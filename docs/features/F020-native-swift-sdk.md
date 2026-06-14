# F020 — Native Swift SDK (`upmetrics-swift`)

> **Status:** building v1. First consumer: **buddy mobile** (native iOS app, mid two-way-speech-dialog overhaul — crash capture is most valuable during a big overhaul). buddy owns the app code; upmetrics ships the SDK + the integration contract (we never edit buddy's repo).

## Motivation

The fleet's error/telemetry hub (upmetrics) is fed by `@upmetrics/sdk` (JS/TS) for web + node + Capacitor surfaces. **Native Swift iOS apps have no path in** — a crash in a native app never reaches the fleet dashboard. As native apps appear (buddy mobile first), we need a Swift SDK that captures errors + crashes and sends them to the **same ingest endpoint, same Sentry-envelope contract**, so native crashes land in the exact same issues/dashboard as the rest of the fleet.

## Scope (v1 — F020.1)

**Error + crash capture only. NO AI-cost.** Cost ingest needs the secret `uk_` key; a secret must NEVER ship in a mobile binary (extractable) — and the fleet rule is that cost is measured server-side in the thin cloud, not in Swift/Kotlin. The Swift SDK uses ONLY the **public DSN** (same class as the JS SDK's DSN), so it is safe to ship in an App Store build.

- **Same contract as `@upmetrics/sdk`:** parse `https://<publicKey>@<host>/<projectId>`; POST `application/x-sentry-envelope` to `{host}/api/{projectId}/envelope/?sentry_key=<publicKey>` — a 3-line envelope (`{event_id,sent_at}` / `{type:"event"}` / event). `platform:"cocoa"`, self-stamped `sdk:{name:"upmetrics-swift",version}`.
- **Public API:** `Upmetrics.start(dsn:environment:release:)`, `capture(_ error:)`, `capture(message:level:)`, `setUser`, `setTag`, `addBreadcrumb`. Fire-and-forget; telemetry must never throw into the host app.
- **Full native crash capture (Christian chose this over a pragmatic-first v1):**
  - Uncaught `NSException` via `NSSetUncaughtExceptionHandler`.
  - **Signal handlers** for `SIGSEGV, SIGABRT, SIGTRAP, SIGILL, SIGBUS, SIGFPE` — **async-signal-safe**: in-handler we only `write()` a pre-serialised crash record (signal + pre-captured `backtrace()` addresses + binary-image list) to a pre-opened file descriptor, then chain the previous/default handler so the process still dies normally.
  - **Persist-and-flush:** crashes can't send in-process (the process is dying). The handler writes to disk; on next launch `start()` reads any pending crash files, builds exception events, sends them, and deletes them.
  - **Symbolication:** best-effort client-side at flush time (NOT in the handler) via `backtrace_symbols`/`dladdr` (module+symbol+offset). Binary images (load address + UUID) are included in the event so **server-side symbolication of release builds (with the dSYM)** is possible later — see non-goals.
- **Context:** device model, OS version, app version/build, locale — Sentry `contexts`.
- **PII scrubbing** by default (mirror `scrub.ts`): redact emails/tokens/long hex/secret-looking strings from message + frames before send.
- **Offline resilience:** a small on-disk queue so an event captured just before termination (or with no network) is retried on next launch.

### Non-goals (v1)

- **No AI-cost / no `uk_` key in the client** (server-side only — fleet rule).
- **No full release-symbolication pipeline** in v1: we CAPTURE raw addresses + binary images so server-side dSYM symbolication can be added later (an upmetrics-server story), but v1 ships best-effort client-side symbols only.
- **No Android/Kotlin** (separate SDK if ever needed).
- We do NOT edit buddy mobile's code — we deliver the SDK + an integration snippet; buddy wires it.

## Architecture

SwiftPM package (`Package.swift` at the package root). Modules in `Sources/Upmetrics/`:
- `DSN.swift` — parse + validate.
- `Event.swift` — `Codable` Sentry-event model + envelope serialisation.
- `Scrub.swift` — PII redaction (port of `scrub.ts`).
- `Context.swift` — device/OS/app context.
- `Transport.swift` — `URLSession` envelope POST (fire-and-forget + retry queue).
- `CrashReporter.swift` — `NSException` + signal handlers (async-signal-safe write).
- `CrashStore.swift` — persist pending crashes; flush + symbolicate + send on `start()`.
- `Upmetrics.swift` — the public facade (scope: user/tags/breadcrumbs).

## Distribution

SwiftPM is the npm-equivalent. v1 is developed + verified in `packages/swift-sdk/` of the upmetrics repo; for buddy mobile to consume it via SPM it needs a **root-level `Package.swift`**, so it will be published as its own repo **`broberg-ai/upmetrics-swift`** (tagged releases, like the JS SDK publishes to npm). Until then buddy can vendor it / use a local path.

## Verification plan (Christian's hard rule — prove, don't claim)

Swift 6.2 + Xcode 26.3 are on the Mac, so this is fully buildable + testable locally:
1. `swift build` + `swift test` — unit: DSN parse, 3-line envelope format, scrub, event `Codable`.
2. **Live integration:** post a real event to a TEST upmetrics project DSN → confirm the event row lands in the prod DB (fly ssh).
3. **Crash capture:** a test executable installs the handler, raises `SIGABRT` in a child process → confirm the on-disk crash record → re-run → confirm flush sends an exception event that lands in the DB.
4. **Honest limits:** device-only behaviours + release dSYM symbolication can't be fully proven on the Mac — those are verified with buddy mobile on a real device.

## Rollout

- Ship `upmetrics-swift` v1 (built + verified).
- Hand buddy the integration contract (DSN for buddy mobile's project + the `Upmetrics.start(...)` snippet) — same handoff pattern as the deploy contract.
- buddy wires it into buddy mobile; verify a real crash from the app lands in the dashboard.

## Stories

- **F020.1** — `upmetrics-swift` v1: error + full native crash capture (this build).
- (later) F020.2 — server-side dSYM symbolication. F020.3 — dedicated `broberg-ai/upmetrics-swift` repo + tagged SPM release.
