# Capacitor apps → Upmetrics (F003.3, re-scoped per decision 2026-05-30)

**Decision (Christian):** Upmetrics does **not** ship a competitor's SDK
(`@sentry/capacitor`) into our apps. We use **our own `@upmetrics/sdk`**. Native
iOS/Android crash capture is a deliberate **future** decision, not Phase 1.

## What Capacitor apps do (when they opt in — not now)

A Capacitor app runs JS in a WebView. JS/TS errors are captured by our own SDK,
exactly like any web app:

```ts
import { init, captureException } from '@upmetrics/sdk';

init({
  dsn: 'https://<publicKey>@upmetrics.org/<projectId>',
  environment: 'production',
  release: `${appName}@${appVersion}`,
});
// window.onerror + unhandledrejection are auto-instrumented.
```

That covers all JavaScript-layer errors in the Capacitor WebView. **No
`@sentry/capacitor`, no competitor dependency, no native rebuild required beyond
shipping the JS bundle.**

## Native crashes (deferred — future decision)

Native iOS (Swift/objc) and Android (JVM/NDK) crashes happen *outside* the
WebView, so the JS SDK can't see them. Capturing those requires a native crash
handler. Options for a future phase:

- Build a minimal `@upmetrics/capacitor` plugin with our own native crash
  handlers (most work, fully ours).
- Revisit whether native-crash coverage is worth a third-party dependency.

This is **explicitly out of scope for Phase 1**. Phase 1 = our SDK, JS errors.

## Verified test target: cms-mobile (non-App-Store Capacitor app)

`/Users/cb/Apps/webhouse/cms/packages/cms-mobile` — Capacitor (React + TS),
bundle `app.webhouse.cms`, **not published to the App Store** (sideloaded /
Phase-8-future), so it's free to instrument and test. Init point:
`src/main.tsx` (right after `initCapacitor()`):

```ts
import { init } from '@upmetrics/sdk';
init({
  dsn: 'https://<publicKey>@upmetrics.org/cms-mobile',
  environment: import.meta.env.MODE,
  release: `cms-mobile@${appVersion}`,
});
```

An upmetrics project `cms-mobile` (platform `capacitor`) exists with its own DSN.

**Live-verified 2026-05-30:** the real `@upmetrics/sdk` (the exact code a
Capacitor WebView runs) captured a JS error and it landed in the `cms-mobile`
project's upmetrics `issues` on prod — grouped into
*"Error: CmsMobileBoom…"* (level error), event `environment=capacitor-test`,
`issue_id` stamped by the async grouping worker. The SDK ↔ ingest ↔ issues
contract is proven end-to-end against production.

## Cross-repo consumption prerequisite

`@upmetrics/sdk` currently lives as a workspace package in the upmetrics
monorepo. To `import { init } from '@upmetrics/sdk'` from **another** repo
(cms-mobile, and every other site/app per the F008 "embed everywhere" goal) it
must be **published** — npm (public or private/GitHub Packages) or a tarball.
That publish step is the real enabler for wiring the SDK into cms-mobile's
`main.tsx` and running it in the simulator/WebView. Until then the contract is
proven via the SDK executed directly against prod (above).

## Note

The Upmetrics ingest is Sentry-envelope-compatible (F002.1), so it *can* accept
events from any Sentry SDK — but per the decision above we do not use one. The
compatibility remains useful for migrating existing Sentry-instrumented projects
("point the DSN here"), not for shipping Sentry into our own apps.
