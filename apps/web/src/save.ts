import type { NewRecord } from '@farmatics/sync';
import { syncClient } from './offline.js';
import { notify } from './toast.js';

/**
 * Queues work on the phone and confirms it straight away.
 *
 * The local write is what the person is waiting for, so the server catches up
 * in the background. Only a refusal from the server earns a second message;
 * a slow connection never keeps the form open.
 */
export async function saveAndConfirm(
  records: NewRecord[],
  message: string,
  online: boolean,
): Promise<void> {
  await syncClient.saveRecords(records);

  notify(online ? `${message}.` : `${message}. It will sync when this phone has signal.`);

  if (!online) return;

  void syncClient
    .sync()
    .then((result) => {
      if (result.pushed.rejected > 0) {
        notify(
          'Saved on this phone, but the server refused an entry. See Sync on the Account screen.',
          'error',
        );
      }
    })
    .catch(() => {
      // Sync failures already surface through the status pill and the sync card.
    });
}
