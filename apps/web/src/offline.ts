import { createSyncClient, openFarmaticsDb, type SyncClient } from '@farmatics/sync';
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
