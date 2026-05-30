import { useState, useRef, useEffect } from 'preact/hooks';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-preact';

// Custom date picker — never a native <input type="date"> (system-styled,
// breaks the design system). Popover month grid; value/onChange are YYYY-MM-DD.
const DOW = ['Ma', 'Ti', 'On', 'To', 'Fr', 'Lø', 'Sø'];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function DatePicker({
  value,
  onChange,
  placeholder = 'Vælg dato…',
}: {
  value: string | null;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState(() => (value ? new Date(value) : new Date()));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const first = new Date(view.getFullYear(), view.getMonth(), 1);
  const startPad = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(view.getFullYear(), view.getMonth() + 1, 0).getDate();
  const cells: (number | null)[] = [...Array(startPad).fill(null), ...Array.from({ length: daysInMonth }, (_, i) => i + 1)];
  const monthLabel = view.toLocaleDateString('da-DK', { month: 'long', year: 'numeric' });

  return (
    <div ref={ref} class="relative min-w-40">
      <button
        onClick={() => setOpen((o) => !o)}
        class="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-[var(--surface-2)] active:scale-[0.99]"
        style={{ borderColor: 'var(--border)' }}
      >
        <span class={value ? '' : 'text-[var(--muted)]'}>{value ?? placeholder}</span>
        <Calendar size={14} />
      </button>
      {open && (
        <div class="absolute z-30 mt-1 rounded-md border p-2 shadow-lg" style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}>
          <div class="mb-2 flex items-center justify-between px-1">
            <button onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))} class="rounded p-1 hover:bg-[var(--surface-2)] active:scale-95">
              <ChevronLeft size={15} />
            </button>
            <span class="text-sm font-medium capitalize">{monthLabel}</span>
            <button onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))} class="rounded p-1 hover:bg-[var(--surface-2)] active:scale-95">
              <ChevronRight size={15} />
            </button>
          </div>
          <div class="grid grid-cols-7 gap-0.5 text-center text-xs text-[var(--muted)]">
            {DOW.map((d) => (
              <div key={d} class="py-1">{d}</div>
            ))}
            {cells.map((day, i) => {
              if (day === null) return <div key={`p${i}`} />;
              const ds = ymd(new Date(view.getFullYear(), view.getMonth(), day));
              const selected = ds === value;
              return (
                <button
                  key={ds}
                  onClick={() => {
                    onChange(ds);
                    setOpen(false);
                  }}
                  class="rounded py-1 text-sm hover:bg-[var(--surface-2)] active:scale-95"
                  style={selected ? { background: 'var(--primary)', color: 'var(--primary-fg)' } : undefined}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
