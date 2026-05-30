import { useState } from 'preact/hooks';
import { requestMagicLink } from '../lib/auth';
import { Button } from '../components/ui/controls';

export function Login() {
  const [email, setEmail] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!email) return;
    setState('sending');
    const r = await requestMagicLink(email.trim());
    if (r.ok) setState('sent');
    else {
      setError(r.error ?? 'Sign-in failed');
      setState('error');
    }
  };

  return (
    <div class="grid h-full place-items-center px-4">
      <div class="w-full max-w-sm rounded-xl border p-6" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div class="mb-1 flex items-center gap-2 text-xl font-bold">
          <span class="grid h-8 w-8 place-items-center rounded-md" style={{ background: 'var(--primary)', color: 'var(--primary-fg)' }}>
            U
          </span>
          Upmetrics
        </div>
        <p class="mb-5 text-sm text-[var(--muted)]">Sign in with a magic link.</p>

        {state === 'sent' ? (
          <p class="text-sm">
            ✓ Check your inbox — a sign-in link is on its way to <b>{email}</b>. It expires in 15 minutes.
          </p>
        ) : (
          <form onSubmit={submit} class="space-y-3">
            <input
              type="email"
              required
              value={email}
              onInput={(e) => setEmail((e.target as HTMLInputElement).value)}
              placeholder="you@webhouse.dk"
              class="w-full rounded-md border px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
              style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
            />
            <Button type="submit" loading={state === 'sending'} class="w-full">
              Send magic link
            </Button>
            {state === 'error' && <p class="text-sm" style={{ color: 'var(--down)' }}>{error}</p>}
          </form>
        )}
      </div>
    </div>
  );
}
