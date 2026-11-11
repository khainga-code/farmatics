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
import { api, hasStoredSession } from './api.js';

interface AuthState {
  user: UserDto | null;
  farm: AuthProfile['farm'] | null;
  permissions: Permission[];
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  can: (permission: Permission) => boolean;
  applyProfile: (profile: AuthProfile) => void;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    farm: null,
    permissions: [],
    loading: true,
  });

  useEffect(() => {
    let cancelled = false;

    const restore = async () => {
      if (!hasStoredSession()) {
        if (!cancelled) setState((s) => ({ ...s, loading: false }));
        return;
      }
      try {
        const profile = await api.restoreSession();
        if (cancelled) return;
        setState({
          user: profile?.user ?? null,
          farm: profile?.farm ?? null,
          permissions: profile?.permissions ?? [],
          loading: false,
        });
      } catch {
        if (!cancelled) setState({ user: null, farm: null, permissions: [], loading: false });
      }
    };

    void restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const applyProfile = useCallback((profile: AuthProfile) => {
    setState({
      user: profile.user,
      farm: profile.farm,
      permissions: profile.permissions,
      loading: false,
    });
  }, []);

  const refresh = useCallback(async () => {
    const profile = await api.profile();
    applyProfile(profile);
  }, [applyProfile]);

  const signOut = useCallback(async () => {
    await api.logout();
    setState({ user: null, farm: null, permissions: [], loading: false });
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      ...state,
      applyProfile,
      refresh,
      signOut,
      can: (permission: Permission) => state.permissions.includes(permission),
    }),
    [state, applyProfile, refresh, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
