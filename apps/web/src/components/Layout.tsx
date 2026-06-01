import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { LayoutDashboard, Bug, Bot, Activity, AlertTriangle, Wrench, Moon, Sun, LogOut } from 'lucide-preact';
import { cn } from '../lib/cn';
import { signOut, type SessionUser } from '../lib/auth';
import logoUrl from '../assets/logo.svg';
import { IncidentsBar } from './IncidentsBar';

const NAV = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/issues', label: 'Issues', icon: Bug },
  { href: '/agents', label: 'Agents', icon: Bot },
  { href: '/probes', label: 'Probes', icon: Activity },
  { href: '/incidents', label: 'Incidents', icon: AlertTriangle },
  { href: '/remediation', label: 'Remediation', icon: Wrench },
];

export function Layout({ user, children }: { user: SessionUser; children: ComponentChildren }) {
  const { path } = useLocation();
  const [dark, setDark] = useState(document.documentElement.classList.contains('dark'));
  const toggleDark = () => {
    const next = !dark;
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('upm-theme', next ? 'dark' : 'light');
    setDark(next);
  };

  const themeBtns = (
    <div class="flex gap-1">
      <button onClick={toggleDark} class="flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-2)] active:scale-95" title="Toggle theme">
        {dark ? <Sun size={15} /> : <Moon size={15} />}
      </button>
      <button
        onClick={() => signOut().then(() => location.reload())}
        class="flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-2)] active:scale-95"
        title="Sign out"
      >
        <LogOut size={15} />
      </button>
    </div>
  );

  return (
    <div class="flex h-full">
      {/* Desktop sidebar (≥lg) */}
      <aside class="hidden w-56 flex-col border-r lg:flex" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        <div class="flex items-center gap-2 px-4 py-4 text-lg font-bold">
          <span class="grid h-7 w-7 place-items-center rounded-md" style={{ background: '#f7efe8' }}>
            <img src={logoUrl} alt="" class="h-[1.15rem] w-[1.15rem]" />
          </span>
          Upmetrics
        </div>
        <nav class="flex-1 space-y-1 px-2">
          {NAV.map(({ href, label, icon: Icon }) => {
            const active = href === '/' ? path === '/' : path.startsWith(href);
            return (
              <a
                key={href}
                href={href}
                class={cn(
                  'flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition',
                  active ? 'font-medium' : 'text-[var(--muted)] hover:bg-[var(--surface-2)]',
                )}
                style={active ? { background: 'var(--surface-2)', color: 'var(--text)' } : undefined}
              >
                <Icon size={16} />
                {label}
              </a>
            );
          })}
        </nav>
        <div class="border-t p-2" style={{ borderColor: 'var(--border)' }}>
          <div class="px-2 py-1 text-xs text-[var(--muted)] truncate">{user.email}</div>
          {themeBtns}
        </div>
      </aside>

      <main class="flex min-w-0 flex-1 flex-col overflow-auto">
        {/* Mobile top bar (<lg) */}
        <header class="flex items-center justify-between border-b px-4 py-2.5 lg:hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div class="flex items-center gap-2 font-bold">
            <span class="grid h-6 w-6 place-items-center rounded-md" style={{ background: '#f7efe8' }}>
              <img src={logoUrl} alt="" class="h-4 w-4" />
            </span>
            Upmetrics
          </div>
          <div class="w-24">{themeBtns}</div>
        </header>

        <IncidentsBar />
        {/* pb-20 on mobile keeps content clear of the fixed bottom tab bar */}
        <div class="flex-1 p-4 pb-20 lg:p-6 lg:pb-6">{children}</div>
      </main>

      {/* Mobile bottom tab bar (<lg) */}
      <nav class="fixed inset-x-0 bottom-0 z-40 flex border-t lg:hidden" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = href === '/' ? path === '/' : path.startsWith(href);
          return (
            <a
              key={href}
              href={href}
              class="flex flex-1 flex-col items-center gap-0.5 py-2 text-[0.625rem] transition active:scale-95"
              style={{ color: active ? 'var(--primary)' : 'var(--muted)' }}
              aria-label={label}
            >
              <Icon size={20} />
              {label}
            </a>
          );
        })}
      </nav>
    </div>
  );
}
