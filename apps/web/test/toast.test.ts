import { describe, expect, it } from 'vitest';
import { notify, subscribeToToasts, type ToastMessage } from '../src/toast.js';

describe('save confirmations', () => {
  it('hands a message to every listener and stops after unsubscribe', () => {
    const seen: ToastMessage[] = [];
    const stopFirst = subscribeToToasts((toast) => seen.push(toast));
    const stopSecond = subscribeToToasts(() => {});

    notify('Batch saved', 'success');
    stopFirst();
    stopSecond();
    notify('Nobody is listening');

    expect(seen.map((toast) => toast.text)).toEqual(['Batch saved']);
    expect(seen[0]?.tone).toBe('success');
  });

  it('marks failures so the screen can announce them', () => {
    const seen: ToastMessage[] = [];
    const stop = subscribeToToasts((toast) => seen.push(toast));

    notify('Could not save on this phone.', 'error');
    stop();

    expect(seen[0]?.tone).toBe('error');
  });
});
