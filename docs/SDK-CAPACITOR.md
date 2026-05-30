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

## Note

The Upmetrics ingest is Sentry-envelope-compatible (F002.1), so it *can* accept
events from any Sentry SDK — but per the decision above we do not use one. The
compatibility remains useful for migrating existing Sentry-instrumented projects
("point the DSN here"), not for shipping Sentry into our own apps.
