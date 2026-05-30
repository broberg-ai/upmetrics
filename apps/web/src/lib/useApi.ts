import { useEffect, useState } from 'preact/hooks';
import { api, ApiError } from './api';

interface State<T> {
  loading: boolean;
  data: T | null;
  error: string | null;
}

// Small GET-and-render hook. Re-fetches when `path` changes.
export function useApi<T>(path: string): State<T> & { reload: () => void } {
  const [tick, setTick] = useState(0);
  const [state, setState] = useState<State<T>>({ loading: true, data: null, error: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, data: null, error: null });
    api<T>(path)
      .then((d) => alive && setState({ loading: false, data: d, error: null }))
      .catch((e) => alive && setState({ loading: false, data: null, error: e instanceof ApiError ? e.message : String(e) }));
    return () => {
      alive = false;
    };
  }, [path, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}
