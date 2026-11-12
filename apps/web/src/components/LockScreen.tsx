import { useState, type FormEvent } from 'react';
import { useAuth, unlockMessage } from '../auth.js';
import { Alert, AuthShell, Button, Field } from './ui.js';

/**
 * Shown when the app opens with no network. The saved session says who the
 * user is; the PIN proves it is the same person holding the phone.
 */
export function LockScreen() {
  const { user, farm, online, unlock, signOut } = useAuth();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const firstName = user?.name.split(' ')[0] ?? 'there';

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const attempt = await unlock(pin);
      if (!attempt.ok) {
        setError(unlockMessage(attempt.reason));
        setPin('');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title={`Welcome back, ${firstName}`}
      subtitle={`${farm?.name ?? 'Your farm'} · PIN unlock works without internet.`}
      footer={
        <button className="link-button" type="button" onClick={() => void signOut()}>
          Sign out of this phone
        </button>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {!online && (
          <Alert tone="warning">
            No internet. Your work is saved on this phone and will sync when you reconnect.
          </Alert>
        )}
        {error && <Alert tone="error">{error}</Alert>}

        <Field
          label="PIN"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="current-password"
          maxLength={6}
          placeholder="4 to 6 digits"
          value={pin}
          onChange={(event) => setPin(event.target.value.replace(/\D/g, ''))}
          autoFocus
          required
        />

        <Button type="submit" block loading={busy} disabled={pin.length < 4}>
          Unlock
        </Button>
      </form>
    </AuthShell>
  );
}
