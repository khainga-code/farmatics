import Dexie, { type Table } from 'dexie';
import type { Permission } from '@farmatics/shared';
import type { FarmDto, UserDto } from '@farmatics/shared';

/**
 * The phone's own database.
 *
 * Two rules make offline-first safe:
 *   1. A save writes the local record and its outbox entry in one Dexie
 *      transaction, so the app can never show a record it will forget to send.
 *   2. The outbox entry carries the id the phone generated. A retry therefore
 *      collides with itself on the server instead of creating a second record.
 */

export interface OutboxEntry {
  /** `${table}:${recordId}` - one queued write per record. */
  id: string;
  table: string;
  recordId: string;
  data: Record<string, unknown>;
  createdAt: string;
  attempts: number;
  status: 'pending' | 'rejected';
  reason?: string;
  message?: string;
}

export interface LocalRecord {
  /** `${table}:${id}` */
  key: string;
  table: string;
  id: string;
  data: Record<string, unknown>;
  /** Null until the server has acknowledged the record. */
  changeSeq: string | null;
  deletedAt: string | null;
  /** True while the record is still waiting in the outbox. */
  dirty: boolean;
  updatedAt: string;
}

export interface MetaEntry {
  key: string;
  value: string;
}

export interface PinVerifier {
  algorithm: 'PBKDF2-SHA256';
  iterations: number;
  salt: string;
  hash: string;
}

export interface OfflineSession {
  id: 'current';
  user: UserDto;
  farm: FarmDto;
  permissions: Permission[];
  deviceId: string;
  /** Last time the phone talked to the server. Drives the offline-day limit. */
  lastOnlineAt: string;
  /** Null until the staff member has chosen a PIN on this phone. */
  pinVerifier: PinVerifier | null;
}

export function recordKey(table: string, id: string): string {
  return `${table}:${id}`;
}

export class FarmaticsDb extends Dexie {
  declare outbox: Table<OutboxEntry, string>;
  declare records: Table<LocalRecord, string>;
  declare meta: Table<MetaEntry, string>;
  declare session: Table<OfflineSession, string>;

  constructor(name = 'farmatics') {
    super(name);
    this.version(1).stores({
      outbox: 'id, table, status, createdAt',
      records: 'key, table, changeSeq, dirty, updatedAt',
      meta: 'key',
      session: 'id',
    });
  }
}

export function openFarmaticsDb(name?: string): FarmaticsDb {
  return new FarmaticsDb(name);
}

/** Closes a phone database and removes it. Used by tests and sign-out. */
export async function deleteFarmaticsDb(db: FarmaticsDb): Promise<void> {
  const name = db.name;
  db.close();
  await Dexie.delete(name);
}
