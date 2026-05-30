// Better Auth session wiring for the SPA (F016). The session cookie is set by
// the magic-link verify; here we read it via /api/auth/get-session and expose
// a hook + a login trigger.
import { useEffect, useState } from 'preact/hooks';

export interface SessionUser {
  email: string;
  name?: string;
  role?: string;
}

interface SessionState {
  loading: boolean;
  user: SessionUser | null;
}

export function useSession(): SessionState {
  const [state, setState] = useState<SessionState>({ loading: true, user: null });
  useEffect(() => {
    let alive = true;
    fetch('/api/auth/get-session', { credentials: 'include' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { user?: SessionUser } | null) => {
        if (alive) setState({ loading: false, user: data?.user ?? null });
      })
      .catch(() => alive && setState({ loading: false, user: null }));
    return () => {
      alive = false;
    };
  }, []);
  return state;
}

// Request a magic link. Returns true if the email was accepted (allowlisted).
export async function requestMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/auth/sign-in/magic-link', {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, callbackURL: '/' }),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return { ok: false, error: body.message ?? `Sign-in failed (${res.status})` };
}

export async function signOut(): Promise<void> {
  await fetch('/api/auth/sign-out', { method: 'POST', credentials: 'include' }).catch(() => {});
}
