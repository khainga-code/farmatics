import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api.js';
import { useAuth } from '../auth.js';
import { Alert, AuthShell, Button, Field } from '../components/ui.js';

interface VerifyState {
  phone?: string;
  devCode?: string;
}

export function VerifyPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const { applyProfile } = useAuth();
  const state = (location.state ?? null) as VerifyState | null;

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!state?.phone) return <Navigate to="/register" replace />;

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    try {
      await api.verifyRegistration(state!.phone!, code);
      const profile = await api.profile();
      await applyProfile(profile);
      navigate('/', { replace: true });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Enter your code"
      subtitle={`We sent a six-digit code to ${state.phone}.`}
      footer={
        <>
          Wrong number? <Link to="/register">Start again</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}
        {state.devCode && (
          <Alert tone="info">
            Development mode — your code is <strong className="mono">{state.devCode}</strong>
          </Alert>
        )}

        <Field
          label="Six-digit code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="000000"
          className="input input--code"
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          required
        />

        <Button type="submit" block loading={busy} disabled={code.length !== 6}>
          Verify and continue
        </Button>
      </form>
    </AuthShell>
  );
}
