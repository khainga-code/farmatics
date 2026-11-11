import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api.js';
import { useAuth } from '../auth.js';
import { Alert, AuthShell, Button, Field } from '../components/ui.js';

export function StaffLoginPage() {
  const navigate = useNavigate();
  const { applyProfile } = useAuth();
  const [username, setUsername] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.staffLogin(username, pin);
      applyProfile(await api.profile());
      navigate('/', { replace: true });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Staff sign-in"
      subtitle="Use the username and PIN your farm owner gave you."
      footer={
        <>
          Farm owner? <Link to="/login">Sign in with a password</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}

        <Field
          label="Username"
          name="username"
          autoComplete="username"
          placeholder="e.g. joseph"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
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
          required
        />

        <Button type="submit" block loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
