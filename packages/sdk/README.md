# @upmetrics/sdk

Error-tracking SDK for browser / node / bun. Sends Sentry-envelope-compatible
events to an Upmetrics ingest endpoint, with PII scrubbing on by default.

```ts
import { init, captureException, captureMessage } from '@upmetrics/sdk';

init({
  dsn: 'https://<publicKey>@upmetrics.org/<projectId>',
  environment: 'production',
  release: `${appName}@${appVersion}`,
});

// window.onerror, unhandledrejection and failed fetches are auto-instrumented.
// Manual capture:
captureException(new Error('boom'));
captureMessage('something happened', 'warning');
```

PII scrubbing drops `Authorization`/`Cookie`/key headers and masks
email / Danish CPR / phone patterns before send. Disable with
`init({ ..., disableScrub: true })` (not recommended).
