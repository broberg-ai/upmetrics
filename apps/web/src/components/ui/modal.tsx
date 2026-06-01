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
        class="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-xl border p-5 shadow-2xl"
        style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div class="mb-4 flex items-center justify-between">
          <h2 class="text-base font-semibold">{title}</h2>
          <button onClick={onClose} class="rounded p-1 hover:bg-[var(--surface-2)] active:scale-95" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
