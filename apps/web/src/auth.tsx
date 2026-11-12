import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AuthProfile, Permission, UserDto } from '@farmatics/shared';
import {
  clearSession,
  createPinVerifier,
  loadSession,
  offlineExpired,
  saveSession,
  setPinVerifier,
  touchSession,
  unlockSession,
  type UnlockResult,
} from '@farmatics/sync';
import { api, hasStoredSession } from './api.js';
import { syncDb } from './offline.js';

interface AuthState {
  user: UserDto | null;
  farm: AuthProfile['farm'] | null;
  permissions: Permission[];
  loading: boolean;
  /** True when the app opened offline and is waiting for the PIN. */
  locked: boolean;
  online: boolean;
  /** Shown on the sign-in screen, e.g. after the offline window ran out. */
  notice: string | null;
}

export type UnlockAttempt = { ok: true } | { ok: false; reason: string };

interface AuthContextValue extends AuthState {
  can: (permission: Permission) => boolean;
  applyProfile: (profile: AuthProfile) => Promise<void>;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  unlock: (pin: string) => Promise<UnlockAttempt>;
  /** Stores a local verifier so the chosen PIN works with no signal. */
  rememberPin: (pin: string) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const emptyState: AuthState = {
  user: null,
  farm: null,
  permissions: [],
  loading: false,
  locked: false,
  online: true,
  notice: null,
};

function unlockMessage(reason: string): string {
  switch (reason) {
    case 'no-pin':
      return 'This phone has no PIN yet. Connect to the internet and set one from the dashboard.';
    case 'expired':
      return 'This phone has been offline too long. Connect to the internet and sign in again.';
    case 'no-session':
      return 'This phone is not signed in. Connect to the internet and sign in.';
    default:
      return 'That PIN is not correct.';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    ...emptyState,
    loading: true,
    online: typeof navigator === 'undefined' ? true : navigator.onLine,
  });

  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!hasStoredSession()) {
        if (!cancelled) setState((current) => ({ ...current, loading: false }));
        return;
      }

      try {
        const profile = await api.restoreSession();
        if (cancelled) return;

        if (!profile) {
          // The refresh token was refused. Do not trust the stale local copy.
          await clearSession(syncDb);
          if (!cancelled) {
            setState({
              ...emptyState,
              online: navigator.onLine,
              notice: 'Your session has ended. Sign in again.',
            });
          }
          return;
        }

        const deviceId = api.currentDeviceId();
        if (deviceId) {
          await saveSession(syncDb, {
            user: profile.user,
            farm: profile.farm,
            permissions: profile.permissions,
            deviceId,
          });
        }

        if (!cancelled) {
          setState({
            user: profile.user,
            farm: profile.farm,
            permissions: profile.permissions,
            loading: false,
            locked: false,
            online: navigator.onLine,
            notice: null,
          });
        }
      } catch {
        // No network. Fall back to the session this phone saved.
        const session = await loadSession(syncDb);
        if (cancelled) return;

        if (session && !offlineExpired(session)) {
          setState({
            user: session.user,
            farm: session.farm,
            permissions: session.permissions,
            loading: false,
            locked: true,
            online: false,
            notice: null,
          });
        } else {
          if (session) await clearSession(syncDb);
          setState({
            ...emptyState,
            online: false,
            notice:
              'This phone has been offline for too long. Connect to the internet and sign in again.',
          });
        }
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleOnline = () => setState((current) => ({ ...current, online: true }));
    const handleOffline = () => setState((current) => ({ ...current, online: false }));

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const applyProfile = useCallback(async (profile: AuthProfile) => {
    setState({
      user: profile.user,
      farm: profile.farm,
      permissions: profile.permissions,
      loading: false,
      locked: false,
      online: navigator.onLine,
      notice: null,
    });

    // The sign-in screens await this, so a PIN saved straight afterwards finds
    // the session row already in place.
    const deviceId = api.currentDeviceId();
    if (deviceId) {
      try {
        await saveSession(syncDb, {
          user: profile.user,
          farm: profile.farm,
          permissions: profile.permissions,
          deviceId,
        });
        await touchSession(syncDb);
      } catch {
        // A local write failure must not block an otherwise good sign-in.
      }
    }
  }, []);

  const refresh = useCallback(async () => {
    const profile = await api.profile();
    applyProfile(profile);
  }, [applyProfile]);

  const signOut = useCallback(async () => {
    await api.logout();
    await clearSession(syncDb);
    setState({ ...emptyState, online: navigator.onLine });
  }, []);

  const unlock = useCallback(async (pin: string): Promise<UnlockAttempt> => {
    const result: UnlockResult = await unlockSession(syncDb, pin);
    if (!result.ok) return { ok: false, reason: result.reason };

    setState({
      user: result.session.user,
      farm: result.session.farm,
      permissions: result.session.permissions,
      loading: false,
      locked: false,
      online: navigator.onLine,
      notice: null,
    });
    return { ok: true };
  }, []);

  const rememberPin = useCallback(async (pin: string) => {
    await setPinVerifier(syncDb, await createPinVerifier(pin));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      applyProfile,
      refresh,
      signOut,
      unlock,
      rememberPin,
      can: (permission: Permission) => state.permissions.includes(permission),
    }),
    [state, applyProfile, refresh, signOut, unlock, rememberPin],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}

export { unlockMessage };
