// F009.1 — dogfood: capture the upmetrics server's OWN errors into upmetrics.
// Guarded by a dynamic import + try/catch so a missing SDK or DSN is a harmless
// no-op (the standalone Docker `bun install` can't resolve the workspace
// package until @upmetrics/sdk is published — F009.2; until then this activates
// only where the SDK resolves, e.g. local dev).
import { config } from './config';

type Capture = (err: unknown, ctx?: Record<string, unknown>) => void;
let _capture: Capture | null = null;

export async function initDogfood(): Promise<void> {
  if (!config.selfDsn) return;
  try {
    // Variable specifier + local type so this typechecks + builds WITHOUT the
    // dep present; resolves @upmetrics/sdk at runtime once installed (F009.2).
    const pkg = '@upmetrics/sdk' as string;
    const sdk = (await import(pkg)) as {
      init: (o: { dsn: string; environment?: string; release?: string; autoInstrument?: boolean }) => void;
      captureException: (err: unknown, ctx?: Record<string, unknown>) => string | null;
    };
    sdk.init({ dsn: config.selfDsn, environment: config.nodeEnv, release: 'upmetrics-server', autoInstrument: false });
    _capture = (err, ctx) => sdk.captureException(err, ctx);
    process.on?.('unhandledRejection', (reason) => _capture?.(reason));
    console.log('[dogfood] @upmetrics/sdk → self-monitoring active');
  } catch (err) {
    console.warn('[dogfood] @upmetrics/sdk unavailable (not published yet?):', err instanceof Error ? err.message : err);
  }
}

// Fire-and-forget self-capture; no-op until initDogfood() wires the SDK.
export function captureSelf(err: unknown, ctx?: Record<string, unknown>): void {
  _capture?.(err, ctx);
}
