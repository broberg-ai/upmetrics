import { createContext, type ComponentChildren } from 'preact';
import { useContext, useState, useCallback } from 'preact/hooks';
import { CheckCircle2, Info, XCircle } from 'lucide-preact';

type Kind = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  msg: string;
  kind: Kind;
}

const ToastCtx = createContext<(msg: string, kind?: Kind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

let seq = 0;
export function ToastProvider({ children }: { children: ComponentChildren }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((msg: string, kind: Kind = 'info') => {
    const id = ++seq;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);

  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div class="fixed bottom-4 right-4 z-[100] flex flex-col gap-2">
        {toasts.map((t) => {
          const Icon = t.kind === 'success' ? CheckCircle2 : t.kind === 'error' ? XCircle : Info;
          const color = t.kind === 'success' ? 'var(--ok)' : t.kind === 'error' ? 'var(--down)' : 'var(--primary)';
          return (
            <div
              key={t.id}
              class="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm shadow-lg"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            >
              <Icon size={16} color={color} />
              <span>{t.msg}</span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}
