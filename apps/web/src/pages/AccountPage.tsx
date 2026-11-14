import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Role, UserDto } from '@farmatics/shared';
import { ApiError, api } from '../api.js';
import { useAuth } from '../auth.js';
import { AppLayout } from '../components/AppLayout.js';
import { Alert, Badge, Button, ConfirmButton, Field } from '../components/ui.js';
import { SyncCard } from '../components/SyncCard.js';
import { ASSIGNABLE_ROLES, initialsOf, permissionLabel, ROLE_LABELS } from '../labels.js';

/**
 * Everything about the person and this phone, kept off the dashboard so the
 * home screen can stay about the farm's work.
 */
export function AccountPage() {
  const { user, farm, permissions, refresh, signOut } = useAuth();
  const isManager = permissions.includes('manage_accounts');

  const [employees, setEmployees] = useState<UserDto[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const [form, setForm] = useState({
    name: '',
    phone: '',
    username: '',
    role: 'stock_keeper' as Role,
  });
  const [formError, setFormError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [tempPin, setTempPin] = useState<{ username: string; pin: string } | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const loadEmployees = useCallback(async () => {
    setLoadingList(true);
    setListError(null);
    try {
      setEmployees(await api.listEmployees());
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not load the team.');
    } finally {
      setLoadingList(false);
    }
  }, []);

  useEffect(() => {
    if (isManager) void loadEmployees();
  }, [isManager, loadEmployees]);

  if (!user) return null;

  async function createEmployee(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setFormError(null);

    try {
      const created = await api.createEmployee(form);
      setTempPin({ username: form.username, pin: created.tempPin });
      setForm({ name: '', phone: '', username: '', role: 'stock_keeper' });
      setShowForm(false);
      await loadEmployees();
    } catch (caught) {
      setFormError(caught instanceof ApiError ? caught.message : 'Could not create the account.');
    } finally {
      setCreating(false);
    }
  }

  async function toggleStatus(employee: UserDto) {
    const next = employee.status === 'active' ? 'suspended' : 'active';
    try {
      const updated = await api.setEmployeeStatus(employee.id, next);
      setEmployees((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not change the account.');
    }
  }

  async function unlock(employee: UserDto) {
    try {
      await api.unlockEmployee(employee.id);
      setListError(null);
    } catch (caught) {
      setListError(caught instanceof ApiError ? caught.message : 'Could not unlock the account.');
    }
  }

  async function leave() {
    setSigningOut(true);
    try {
      await signOut();
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <AppLayout title="Account" subtitle="Your profile, access and this phone">
      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Profile</h2>
          <Badge tone="green">{ROLE_LABELS[user.role]}</Badge>
        </div>
        <div className="card-body">
          <div className="profile-row">
            <span className="avatar avatar--lg" aria-hidden="true">
              {initialsOf(user.name)}
            </span>
            <div>
              <div className="list-title">{user.name}</div>
              <div className="list-sub">{user.phone}</div>
            </div>
          </div>
          <div className="status-grid">
            <div>
              <div className="status-label">Farm</div>
              <div className="status-value">{farm?.name ?? '—'}</div>
            </div>
            <div>
              <div className="status-label">Currency</div>
              <div className="status-value">{farm?.currency ?? 'KES'}</div>
            </div>
            <div>
              <div className="status-label">Works offline</div>
              <div className="status-value">{farm?.offlineDaysAllowed ?? 14} days</div>
            </div>
          </div>
        </div>
      </section>

      {user.mustChangePin && (
        <ChangePinCard mustProvideCurrent onChanged={() => void refresh()} />
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">Your access</h2>
          <Badge tone="green">{ROLE_LABELS[user.role]}</Badge>
        </div>
        <div className="card-body">
          <div className="chips">
            {permissions.map((permission) => (
              <span className="chip" key={permission}>
                {permissionLabel(permission)}
              </span>
            ))}
          </div>
          <p className="muted">
            Only these actions appear on this phone. A manager can change them by moving you to
            another role.
          </p>
        </div>
      </section>

      {!user.mustChangePin && (
        <ChangePinCard mustProvideCurrent={false} onChanged={() => void refresh()} />
      )}

      <div id="sync">
        <SyncCard />
      </div>

      {isManager && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">Team</h2>
            <Button variant="ghost" onClick={() => setShowForm((open) => !open)}>
              {showForm ? 'Cancel' : 'Add employee'}
            </Button>
          </div>

          <div className="card-body">
            {tempPin && (
              <Alert tone="success">
                <strong>Temporary PIN for {tempPin.username}:</strong>{' '}
                <span className="mono pin">{tempPin.pin}</span>
                <br />
                Write it down now. It is shown once and must be changed at first sign-in.
                <div className="pin-actions">
                  <Button
                    variant="ghost"
                    onClick={() => void navigator.clipboard?.writeText(tempPin.pin)}
                  >
                    Copy PIN
                  </Button>
                  <Button variant="ghost" onClick={() => setTempPin(null)}>
                    Dismiss
                  </Button>
                </div>
              </Alert>
            )}

            {formError && <Alert tone="error">{formError}</Alert>}

            {showForm && (
              <form className="form form--inline" onSubmit={createEmployee} noValidate>
                <Field
                  label="Full name"
                  value={form.name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, name: event.target.value }))
                  }
                  placeholder="e.g. Joseph Mwangi"
                  required
                />
                <Field
                  label="Phone number"
                  type="tel"
                  inputMode="tel"
                  value={form.phone}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, phone: event.target.value }))
                  }
                  placeholder="0712 345 678"
                  required
                />
                <Field
                  label="Username"
                  value={form.username}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      username: event.target.value.toLowerCase(),
                    }))
                  }
                  placeholder="e.g. joseph"
                  hint="Used with a PIN to sign in."
                  required
                />
                <div className="field">
                  <label className="field-label" htmlFor="employee-role">
                    Role
                  </label>
                  <select
                    id="employee-role"
                    className="input"
                    value={form.role}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        role: event.target.value as Role,
                      }))
                    }
                  >
                    {ASSIGNABLE_ROLES.map((role) => (
                      <option key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </option>
                    ))}
                  </select>
                </div>
                <Button type="submit" loading={creating}>
                  Create account
                </Button>
              </form>
            )}

            {listError && <Alert tone="error">{listError}</Alert>}
            {loadingList && employees.length === 0 && <p className="muted">Loading team…</p>}

            {employees.length === 0 && !loadingList ? (
              <p className="muted">
                No employees yet. Add your stock keeper and salespeople so they can sign in on
                their phones.
              </p>
            ) : (
              <ul className="list">
                {employees.map((employee) => (
                  <li className="list-item" key={employee.id}>
                    <div>
                      <div className="list-title">
                        {employee.name}{' '}
                        {employee.status === 'suspended' && <Badge tone="red">Suspended</Badge>}
                        {employee.mustChangePin && <Badge tone="amber">PIN not set</Badge>}
                      </div>
                      <div className="list-sub">
                        {ROLE_LABELS[employee.role]} · @{employee.username} · {employee.phone}
                      </div>
                    </div>
                    <div className="list-actions">
                      <Button variant="ghost" onClick={() => void unlock(employee)}>
                        Unlock
                      </Button>
                      {employee.status === 'active' ? (
                        <ConfirmButton
                          confirmLabel="Tap to confirm"
                          onConfirm={() => void toggleStatus(employee)}
                        >
                          Suspend
                        </ConfirmButton>
                      ) : (
                        <Button variant="ghost" onClick={() => void toggleStatus(employee)}>
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">This phone</h2>
        </div>
        <div className="card-body">
          <p className="muted">
            Signing out turns off PIN unlock on this phone until you sign in again. Work already
            saved here is not deleted.
          </p>
          <ConfirmButton
            variant="danger"
            confirmLabel="Tap again to sign out"
            block
            loading={signingOut}
            onConfirm={() => void leave()}
          >
            Sign out
          </ConfirmButton>
        </div>
      </section>
    </AppLayout>
  );
}

function ChangePinCard({
  mustProvideCurrent,
  onChanged,
}: {
  mustProvideCurrent: boolean;
  onChanged: () => void;
}) {
  const [currentPin, setCurrentPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const { rememberPin } = useAuth();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setMessage(null);

    if (newPin !== confirmPin) {
      setMessage({ tone: 'error', text: 'The two new PINs do not match.' });
      return;
    }

    setBusy(true);
    try {
      await api.changePin(mustProvideCurrent ? currentPin : undefined, newPin);
      // Keep a local verifier so this PIN also unlocks the app with no signal.
      await rememberPin(newPin).catch(() => {});
      setCurrentPin('');
      setNewPin('');
      setConfirmPin('');
      setMessage({ tone: 'success', text: 'PIN updated.' });
      onChanged();
    } catch (caught) {
      setMessage({
        tone: 'error',
        text: caught instanceof ApiError ? caught.message : 'Could not change the PIN.',
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <h2 className="card-title">{mustProvideCurrent ? 'Set your PIN' : 'Change your PIN'}</h2>
        {mustProvideCurrent && <Badge tone="amber">Required</Badge>}
      </div>
      <div className="card-body">
        <p className="muted">
          {mustProvideCurrent
            ? 'You signed in with a temporary PIN. Choose your own before you start work.'
            : 'Use a PIN you can remember. It unlocks the app on this phone without internet.'}
        </p>
        <form className="form form--inline" onSubmit={onSubmit} noValidate>
          {message && <Alert tone={message.tone}>{message.text}</Alert>}
          {mustProvideCurrent && (
            <Field
              label="Temporary PIN"
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={currentPin}
              onChange={(event) => setCurrentPin(event.target.value.replace(/\D/g, ''))}
              required
            />
          )}
          <Field
            label="New PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            hint="4 to 6 digits."
            value={newPin}
            onChange={(event) => setNewPin(event.target.value.replace(/\D/g, ''))}
            required
          />
          <Field
            label="Confirm new PIN"
            type="password"
            inputMode="numeric"
            maxLength={6}
            value={confirmPin}
            onChange={(event) => setConfirmPin(event.target.value.replace(/\D/g, ''))}
            required
          />
          <Button type="submit" loading={busy}>
            Save PIN
          </Button>
        </form>
      </div>
    </section>
  );
}
