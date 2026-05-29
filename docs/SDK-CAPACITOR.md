# Capacitor apps → Upmetrics (F003.3)

Christian's Capacitor apps (iOS + Android) report errors to Upmetrics using the
**official `@sentry/capacitor` SDK** pointed at an Upmetrics DSN. We do not build
a native SDK — Upmetrics' ingest is Sentry-envelope-compatible (F002.1), so the
Sentry SDK treats it as a Sentry server.

## Pinned version

`@sentry/capacitor` **v2.x** (wraps `@sentry/cocoa` on iOS, `@sentry/android` on
Android). Pin the major and upgrade explicitly — do not float.

## Install (in the Capacitor app, e.g. `fysiodk-aalborg-sport/apps/web`)

```bash
pnpm add @sentry/capacitor @sentry/vue   # or @sentry/react / @sentry/angular per app
```

## Init

```ts
import * as Sentry from '@sentry/capacitor';

Sentry.init({
  // Upmetrics DSN for this project: https://<publicKey>@upmetrics.org/<projectId>
  dsn: 'https://<publicKey>@upmetrics.org/<projectId>',
  environment: import.meta.env.MODE,
  release: `${appName}@${appVersion}`,
  // Standard tag convention so the dashboard can filter native vs web:
  initialScope: {
    tags: { platform: 'capacitor', app_version: appVersion },
  },
});
```

## What works out of the box

- JS errors in the Capacitor WebView (`platform: javascript`)
- Native iOS crashes (objc/Swift, e.g. `EXC_BAD_ACCESS`) — `platform: cocoa`
- Native Android crashes (JVM + NDK) — `platform: android`
- Breadcrumbs, user context, release tags

## Upmetrics-side verification (done, protocol-level)

The ingest endpoint was verified to accept and group both shapes:

- JS event (`platform: javascript`, `level: error`) → issue created
- Native event (`platform: cocoa`, `EXC_BAD_ACCESS`, `mechanism.handled=false`,
  `level: fatal`) → issue created

i.e. `@sentry/capacitor` output (including native crash envelopes) is ingested
and grouped correctly.

## Remaining: on-device test (manual, needs a device build)

Building `fysiodk-aalborg-sport` on a real iOS/Android device + triggering a JS
error and a native crash to confirm both land in Upmetrics issues is a
device-dependent step (Xcode/simulator + the app's build). It is **not** run by
this card — it requires a device build and is Christian's to execute when the app
is next built. The protocol compatibility above guarantees the events will be
accepted once the SDK is wired and a crash fires.

## Phase 2 (deferred)

- iOS dSYM upload + symbolication (native crashes show raw addresses until then)
- Android ProGuard mapping upload
- App-runtime RUM/heartbeats

Probing the app's **backend** API is already covered by F004 (cronjobs probes
from an external host) — not the app client.
