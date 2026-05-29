// Minimal Sentry envelope parser (PLAN §7). Newline-delimited:
//   <envelope header JSON>\n<item header JSON>\n<item payload>\n...
// Item headers may carry a byte `length`; when present we slice exactly that
// many bytes (payload can then contain newlines). Otherwise payload is the
// next single line.
export interface EnvelopeItem {
  type: string;
  headers: Record<string, unknown>;
  payload: unknown;
}

export interface ParsedEnvelope {
  headers: Record<string, unknown>;
  items: EnvelopeItem[];
}

export function parseEnvelope(raw: string): ParsedEnvelope {
  const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  const firstNl = text.indexOf('\n');
  const headerLine = firstNl === -1 ? text : text.slice(0, firstNl);
  const headers = safeJson(headerLine) as Record<string, unknown>;

  const items: EnvelopeItem[] = [];
  let rest = firstNl === -1 ? '' : text.slice(firstNl + 1);

  while (rest.length > 0) {
    const nl = rest.indexOf('\n');
    const itemHeaderLine = nl === -1 ? rest : rest.slice(0, nl);
    rest = nl === -1 ? '' : rest.slice(nl + 1);
    if (itemHeaderLine.trim() === '') continue;

    const itemHeader = safeJson(itemHeaderLine) as Record<string, unknown>;
    const type = String(itemHeader['type'] ?? 'unknown');
    const length = typeof itemHeader['length'] === 'number' ? (itemHeader['length'] as number) : undefined;

    let payloadStr: string;
    if (length !== undefined) {
      payloadStr = rest.slice(0, length);
      rest = rest.slice(length);
      if (rest.startsWith('\n')) rest = rest.slice(1);
    } else {
      const pnl = rest.indexOf('\n');
      payloadStr = pnl === -1 ? rest : rest.slice(0, pnl);
      rest = pnl === -1 ? '' : rest.slice(pnl + 1);
    }
    items.push({ type, headers: itemHeader, payload: safeJson(payloadStr) });
  }

  return { headers, items };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// Sentry DSN: https://<publicKey>@<host>/<projectId>
export function extractPublicKey(dsn: string): string | null {
  try {
    return new URL(dsn).username || null;
  } catch {
    return null;
  }
}
