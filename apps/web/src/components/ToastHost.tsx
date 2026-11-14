import { useEffect, useState } from 'react';
import { subscribeToToasts, type ToastMessage } from '../toast.js';

const VISIBLE_MS = 3500;

/**
 * Shows the latest save confirmation above the tab bar. One at a time is
 * enough: the newest message replaces the old one, and a tap dismisses it.
 */
export function ToastHost() {
  const [toast, setToast] = useState<ToastMessage | null>(null);

  useEffect(() => {
    let timer: number | undefined;

    const stop = subscribeToToasts((next) => {
      setToast(next);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setToast(null), VISIBLE_MS);
    });

    return () => {
      stop();
      window.clearTimeout(timer);
    };
  }, []);

  if (!toast) return null;

  return (
    <div
      key={toast.id}
      className={`toast toast--${toast.tone}`}
      role={toast.tone === 'error' ? 'alert' : 'status'}
      onClick={() => setToast(null)}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span>{toast.text}</span>
    </div>
  );
}
