import { useCallback, useEffect, useState } from 'react';
import type { SyncRejection } from '@farmatics/shared';
import { useAuth } from '../auth.js';
import { syncClient, syncDb } from '../offline.js';
import { Alert, Badge, Button } from './ui.js';

function formatTime(value: string | null): string {
  if (!value) return 'not yet';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'not yet' : date.toLocaleTimeString();
}

/**
 * The phone's sync status.
 *
 * It reports what the user can act on: how many records are waiting, when the
 * last successful sync was, and anything the server refused. Internals stay
 * out of the interface.
 */
export function SyncCard() {
  const { online } = useAuth();
  const [pending, setPending] = useState(0);
  const [attention, setAttention] = useState<SyncRejection[]>([]);
  const [lastSuccess, setLastSuccess] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshState = useCallback(async () => {
    const [waiting, rejected, success, error, saved] = await Promise.all([
      syncClient.pendingCount(),
      syncClient.attention(),
      syncDb.meta.get('lastSuccessAt'),
      syncDb.meta.get('lastError'),
      syncDb.records.count(),
    ]);

    setPending(waiting);
    setAttention(rejected);
    setLastSuccess(success?.value ?? null);
    setLastError(error?.value ?? null);
    setSavedCount(saved);
  }, []);

  useEffect(() => {
    void refreshState();

    // The layout owns the sync loop; the card only listens for changes.
    const unsubscribe = syncClient.subscribe(() => {
      void refreshState();
    });

    const handleOnline = () => {
      void syncClient.sync().then(refreshState);
    };
    window.addEventListener('online', handleOnline);

    return () => {
      unsubscribe();
      window.removeEventListener('online', handleOnline);
    };
  }, [refreshState]);

  async function syncNow() {
    setBusy(true);
    try {
      await syncClient.sync();
      await refreshState();
    } finally {
      setBusy(false);
    }
  }

  /** Development only: proves the whole write -> outbox -> server path. */
  async function recordProbe() {
    const now = new Date();
    const id = crypto.randomUUID();
    await syncClient.saveRecord('probes', id, {
      label: `Test entry ${now.toLocaleTimeString()}`,
      value: 1 + Math.floor(Math.random() * 9),
      recordedAt: now.toISOString(),
      clientTime: now.toISOString(),
    });
    setProbeNote('Saved on this phone. It is queued for sync.');
    await refreshState();
    if (online) {
      await syncClient.sync();
      await refreshState();
      setProbeNote('Saved and synced.');
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">Sync</h2>
        <Badge tone={online ? 'green' : 'amber'}>{online ? 'Online' : 'Offline'}</Badge>
      </div>

      <div className="card-body">
        <div className="status-grid">
          <div>
            <div className="status-label">Waiting to send</div>
            <div className="status-value">{pending === 0 ? 'Nothing' : pending}</div>
          </div>
          <div>
            <div className="status-label">Last synced</div>
            <div className="status-value">{formatTime(lastSuccess)}</div>
          </div>
          <div>
            <div className="status-label">Saved on this phone</div>
            <div className="status-value">{savedCount}</div>
          </div>
        </div>

        {!online && (
          <Alert tone="warning">
            No internet. Work is saved on this phone and will sync by itself when the
            signal returns.
          </Alert>
        )}

        {online && lastError && (
          <Alert tone="error">The last sync did not finish: {lastError}</Alert>
        )}

        {attention.length > 0 && (
          <div className="attention">
            <div className="status-label">Needs attention</div>
            <ul className="list">
              {attention.map((item) => (
                <li className="list-item" key={`${item.table}:${item.id}`}>
                  <div>
                    <div className="list-title">
                      {item.table} · <span className="mono">{item.id.slice(0, 8)}</span>
                    </div>
                    <div className="list-sub">{item.message}</div>
                  </div>
                  <Badge tone="red">{item.reason.replaceAll('_', ' ')}</Badge>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="sync-actions">
          <Button variant="ghost" onClick={() => void syncNow()} loading={busy} disabled={!online}>
            Sync now
          </Button>
          {import.meta.env.DEV && (
            <Button variant="ghost" onClick={() => void recordProbe()}>
              Record test entry (dev)
            </Button>
          )}
        </div>

        {import.meta.env.DEV && probeNote && <p className="muted">{probeNote}</p>}
      </div>
    </section>
  );
}
