import type { ComponentChildren } from 'preact';
import { Spinner } from './ui/controls';

export function Loading() {
  return (
    <div class="grid place-items-center py-20">
      <Spinner size={24} />
    </div>
  );
}

export function ErrorBox({ msg }: { msg: string }) {
  return (
    <div class="rounded-lg border p-4 text-sm" style={{ borderColor: 'var(--down)', color: 'var(--down)' }}>
      {msg}
    </div>
  );
}

export function Empty({ msg }: { msg: string }) {
  return <div class="py-16 text-center text-sm text-[var(--muted)]">{msg}</div>;
}

export function PageHeader({ title, subtitle, right }: { title: string; subtitle?: string; right?: ComponentChildren }) {
  return (
    <div class="mb-5 flex items-end justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{title}</h1>
        {subtitle && <p class="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>}
      </div>
      {right}
    </div>
  );
}
