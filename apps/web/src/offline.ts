import { createSyncClient, loadSession, openFarmaticsDb, type SyncClient } from '@farmatics/sync';
import type { AuthProfile, Permission } from '@farmatics/shared';
import { api } from './api.js';

/**
 * One phone database and one sync client for the whole app.
 *
 * The transport is the authenticated API client, so every push and pull goes
 * through the same refresh-and-retry path as the rest of the app.
 */
export const syncDb = openFarmaticsDb('farmatics');

export const syncClient: SyncClient = createSyncClient({
  db: syncDb,
  transport: {
    push: (records) => api.syncPush(records),
    pull: (cursor, limit) => api.syncPull(cursor, limit),
  },
});

function samePermissions(left: readonly Permission[], right: readonly Permission[]): boolean {
  return left.length === right.length && left.every((permission) => right.includes(permission));
}

/**
 * The pull only carries the tables a user may read, so a change of rights can
 * add or remove whole tables. When that happens - or when a different person
 * signs in on the same phone - the local copy is rebuilt from scratch:
 * queued work is pushed first, the copy and cursor are dropped, then the farm
 * is pulled again with the new permissions.
 *
 * If the server cannot be reached, or anything is still queued, nothing is
 * dropped. The next refresh tries again, and the phone keeps working.
 */
export async function rebuildLocalCopyIfChanged(profile: AuthProfile): Promise<void> {
  const previous = await loadSession(syncDb);
  const hasRecords = (await syncDb.records.count()) > 0;

  const changed =
    previous === null
      ? hasRecords
      : previous.user.id !== profile.user.id ||
        previous.farm.id !== profile.farm.id ||
        !samePermissions(previous.permissions, profile.permissions);

  if (!changed) return;

  try {
    const first = await syncClient.sync();
    // Offline, or work we could not hand over: keep the copy the phone has.
    if (!first.ok || first.pending > 0) return;

    await syncClient.resetRecords();
    await syncClient.sync();
  } catch {
    // Nothing was dropped before the failed step; try again on next refresh.
  }
}
