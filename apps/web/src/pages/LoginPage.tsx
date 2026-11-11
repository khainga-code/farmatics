import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api.js';
import { useAuth } from '../auth.js';
import { Alert, AuthShell, Button, Field } from '../components/ui.js';

export function LoginPage() {
  const navigate = useNavigate();
  const { applyProfile } = useAuth();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.login(phone, password);
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
      title="Welcome back"
      subtitle="Sign in with the phone number and password you registered."
      footer={
        <>
          New here? <Link to="/register">Create a farm account</Link>
          <span className="dot">·</span>
          Staff? <Link to="/staff">Sign in with a PIN</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}

        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0712 345 678"
          value={phone}
          onChange={(event) => setPhone(event.target.value)}
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="Your password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />

        <Button type="submit" block loading={busy}>
          Sign in
        </Button>
      </form>
    </AuthShell>
  );
}
