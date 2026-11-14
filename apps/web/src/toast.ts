export type ToastTone = 'success' | 'error';

export interface ToastMessage {
  id: number;
  text: string;
  tone: ToastTone;
}

/**
 * A one-line confirmation after a save. The store is module-level so any screen
 * can call notify without threading a provider through every form.
 */

const listeners = new Set<(toast: ToastMessage) => void>();
let nextId = 1;

export function notify(text: string, tone: ToastTone = 'success'): void {
  const toast: ToastMessage = { id: nextId, text, tone };
  nextId += 1;
  for (const listener of listeners) listener(toast);
}

export function subscribeToToasts(listener: (toast: ToastMessage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
