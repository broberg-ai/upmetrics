# swift-sdk → moved

The native Swift SDK (`upmetrics-swift`) is now its **own repository** — it is the
canonical single source (SwiftPM consumes git source directly, so it can't also
live here without drift):

**https://github.com/broberg-ai/upmetrics-swift**

Consume it via Swift Package Manager:

```swift
.package(url: "https://github.com/broberg-ai/upmetrics-swift", from: "0.1.0")
```

Plan / design: [`docs/features/F020-native-swift-sdk.md`](../../docs/features/F020-native-swift-sdk.md)
and `F020.1` / `F020.3`. It implements the same Sentry-envelope contract as
[`@upmetrics/sdk`](../sdk) (this repo's JS SDK) against the same ingest endpoint.
