import { useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, api } from '../api.js';
import { Alert, AuthShell, Button, Field } from '../components/ui.js';

export function RegisterPage() {
  const navigate = useNavigate();
  const [values, setValues] = useState({
    farmName: '',
    ownerName: '',
    phone: '',
    password: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof values) => (event: ChangeEvent<HTMLInputElement>) =>
    setValues((current) => ({ ...current, [key]: event.target.value }));

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});

    try {
      const result = await api.registerFarm(values);
      navigate('/verify', {
        state: { phone: result.phone, devCode: result.devCode },
        replace: true,
      });
    } catch (caught) {
      if (caught instanceof ApiError) {
        setError(caught.message);
        const mapped: Record<string, string> = {};
        for (const detail of caught.details ?? []) {
          if (detail.field) mapped[detail.field] = detail.message;
        }
        setFieldErrors(mapped);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Set up your farm"
      subtitle="One account for the farm. You will be its owner and can add your staff afterwards."
      footer={
        <>
          Already registered? <Link to="/login">Sign in</Link>
        </>
      }
    >
      <form className="form" onSubmit={onSubmit} noValidate>
        {error && <Alert tone="error">{error}</Alert>}

        <Field
          label="Farm name"
          name="farmName"
          autoComplete="organization"
          placeholder="e.g. D Ayo Farm"
          value={values.farmName}
          onChange={set('farmName')}
          error={fieldErrors['farmName']}
          required
        />
        <Field
          label="Your name"
          name="ownerName"
          autoComplete="name"
          placeholder="Full name"
          value={values.ownerName}
          onChange={set('ownerName')}
          error={fieldErrors['ownerName']}
          required
        />
        <Field
          label="Phone number"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="0712 345 678"
          hint="We send a six-digit code to this number."
          value={values.phone}
          onChange={set('phone')}
          error={fieldErrors['phone']}
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder="At least 8 characters"
          value={values.password}
          onChange={set('password')}
          error={fieldErrors['password']}
          required
        />

        <Button type="submit" block loading={busy}>
          Create farm account
        </Button>
      </form>
    </AuthShell>
  );
}
