import type { ComponentChildren } from 'preact';
import { useEffect } from 'preact/hooks';
import { X } from 'lucide-preact';

// Custom modal — never a native <dialog>. Scrim click + Escape close it.
export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ComponentChildren;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div class="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.55)' }} onClick={onClose}>
      <div
        class="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border shadow-2xl"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Pinned header — title never scrolls out of view; items-start keeps the
            close button aligned to the top when a long title wraps. */}
        <div class="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4" style={{ borderColor: 'var(--border)' }}>
          <h2 class="text-base font-semibold leading-snug">{title}</h2>
          <button onClick={onClose} class="-mr-1 shrink-0 rounded p-1 hover:bg-[var(--surface-2)] active:scale-95" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {/* The SINGLE scroll region. Callers must not nest their own max-h/overflow. */}
        <div class="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
