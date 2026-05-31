import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { LayoutDashboard, Bug, Bot, Activity, AlertTriangle, Moon, Sun, LogOut } from 'lucide-preact';
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

  return (
    <div class="flex h-full">
      <aside class="flex w-56 flex-col border-r" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
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
          <div class="flex gap-1">
            <button onClick={toggleDark} class="flex flex-1 items-center justify-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--surface-2)] active:scale-95">
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
        </div>
      </aside>

      <main class="flex flex-1 flex-col overflow-auto">
        <IncidentsBar />
        <div class="flex-1 p-6">{children}</div>
      </main>
    </div>
  );
}
