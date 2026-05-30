import type { ComponentChildren, JSX } from 'preact';
import { Loader2 } from 'lucide-preact';
import { cn } from '../../lib/cn';

type Variant = 'primary' | 'ghost' | 'danger' | 'outline';

interface ButtonProps extends Omit<JSX.IntrinsicElements['button'], 'loading'> {
  variant?: Variant;
  loading?: boolean;
}

// Per house rules: every button has hover + active + loading states.
export function Button({ variant = 'primary', loading = false, disabled, class: cls, children, ...rest }: ButtonProps) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition active:scale-[0.97] disabled:opacity-50 disabled:pointer-events-none focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]';
  const variants: Record<Variant, string> = {
    primary: 'text-[var(--primary-fg)] hover:brightness-110',
    danger: 'text-white hover:brightness-110',
    ghost: 'hover:bg-[var(--surface-2)]',
    outline: 'border hover:bg-[var(--surface-2)]',
  };
  const bg = variant === 'primary' ? 'var(--primary)' : variant === 'danger' ? 'var(--down)' : 'transparent';
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      class={cn(base, variants[variant], cls as string)}
      style={{ background: bg }}
    >
      {loading && <Loader2 size={14} class="animate-spin" />}
      {children}
    </button>
  );
}

export function Card({ class: cls, children, ...rest }: JSX.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...rest} class={cn('rounded-xl border p-4', cls as string)} style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
      {children}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <Loader2 size={size} class="animate-spin" color="var(--muted)" />;
}

type Tone = 'ok' | 'warn' | 'down' | 'muted' | 'primary';
const TONE_VAR: Record<Tone, string> = { ok: 'var(--ok)', warn: 'var(--warn)', down: 'var(--down)', muted: 'var(--muted)', primary: 'var(--primary)' };

export function Badge({ tone = 'muted', children }: { tone?: Tone; children: ComponentChildren }) {
  return (
    <span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium" style={{ color: TONE_VAR[tone], background: 'color-mix(in srgb, ' + TONE_VAR[tone] + ' 14%, transparent)' }}>
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: Tone }) {
  return <span class="inline-block h-2.5 w-2.5 rounded-full" style={{ background: TONE_VAR[tone] }} />;
}
