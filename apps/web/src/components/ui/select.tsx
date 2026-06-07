import { useState, useRef, useEffect } from 'preact/hooks';
import { ChevronDown, Check } from 'lucide-preact';

export interface Option {
  value: string;
  label: string;
}

// Custom select — never a native <select> (unstylable, breaks dark mode).
export function CustomSelect({
  value,
  options,
  onChange,
  placeholder = 'Vælg…',
  testid,
}: {
  value: string | null;
  options: Option[];
  onChange: (v: string) => void;
  placeholder?: string;
  testid?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const sel = options.find((o) => o.value === value);
  return (
    <div ref={ref} class="relative min-w-36">
      <button
        data-testid={testid}
        onClick={() => setOpen((o) => !o)}
        class="flex w-full items-center justify-between gap-2 rounded-md border px-3 py-1.5 text-sm hover:bg-[var(--surface-2)] active:scale-[0.99]"
        style={{ borderColor: 'var(--border)' }}
      >
        <span class={sel ? '' : 'text-[var(--muted)]'}>{sel ? sel.label : placeholder}</span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div
          class="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-md border py-1 shadow-lg"
          style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        >
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
              class="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-[var(--surface-2)]"
            >
              <span>{o.label}</span>
              {o.value === value && <Check size={14} color="var(--primary)" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
