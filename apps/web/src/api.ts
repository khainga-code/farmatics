import type {
  AuthProfile,
  CreateEmployeeInput,
  EmployeeCreated,
  TokenBundle,
  UserDto,
} from '@farmatics/shared';

const API_BASE = (import.meta.env['VITE_API_URL'] as string | undefined) ?? '';

const REFRESH_KEY = 'farmatics.refreshToken';
const DEVICE_KEY = 'farmatics.deviceId';
const DEVICE_LABEL_KEY = 'farmatics.deviceLabel';

export class ApiError extends Error {
  readonly code: string;
  readonly details: Array<{ field?: string; message: string }> | undefined;

  constructor(
    message: string,
    code: string,
    details?: Array<{ field?: string; message: string }>,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.details = details;
  }

  fieldError(field: string): string | undefined {
    return this.details?.find((detail) => detail.field === field)?.message;
  }
}

let accessToken: string | null = null;
let refreshToken: string | null = localStorage.getItem(REFRESH_KEY);
let deviceId: string | null = localStorage.getItem(DEVICE_KEY);

/** A stable label so the owner can tell this phone apart from another. */
function deviceLabel(): string {
  const existing = localStorage.getItem(DEVICE_LABEL_KEY);
  if (existing) return existing;
  const label = /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'Phone browser'
    : 'Computer browser';
  localStorage.setItem(DEVICE_LABEL_KEY, label);
  return label;
}

function storeTokens(bundle: TokenBundle): void {
  accessToken = bundle.accessToken;
  refreshToken = bundle.refreshToken;
  deviceId = bundle.deviceId;
  localStorage.setItem(REFRESH_KEY, bundle.refreshToken);
  localStorage.setItem(DEVICE_KEY, bundle.deviceId);
}

export function clearTokens(): void {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem(REFRESH_KEY);
  localStorage.removeItem(DEVICE_KEY);
}

export function hasStoredSession(): boolean {
  return Boolean(refreshToken);
}

async function readBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;

  const body = (await response.json().catch(() => null)) as
    | { error?: { code: string; message: string; details?: Array<{ field?: string; message: string }> } }
    | null;

  if (!response.ok) {
    const error = body?.error;
    throw new ApiError(
      error?.message ?? 'Something went wrong. Try again.',
      error?.code ?? 'unknown',
      error?.details,
    );
  }

  return body as T;
}

/**
 * A single in-flight refresh at a time.
 *
 * Refresh tokens rotate, so two concurrent refreshes would make one of them
 * fail and wipe the session the other just created. Signing in on two tabs, or
 * React's development double-effect, is enough to trigger that.
 */
let refreshInFlight: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;

  const attempted = refreshToken;

  refreshInFlight = (async () => {
    const response = await fetch(`${API_BASE}/api/v1/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: attempted }),
    });

    if (!response.ok) {
      // Only discard the session if it has not already been replaced by a
      // refresh that won the race.
      if (refreshToken === attempted) clearTokens();
      return false;
    }

    storeTokens((await response.json()) as TokenBundle);
    return true;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

async function request<T>(
  path: string,
  init: RequestInit = {},
  allowRetry = true,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  const response = await fetch(`${API_BASE}${path}`, { ...init, headers });

  if (response.status === 401 && allowRetry && refreshToken) {
    if (await refreshSession()) return request<T>(path, init, false);
  }

  return readBody<T>(response);
}

const device = () => ({
  deviceId: deviceId ?? undefined,
  deviceLabel: deviceLabel(),
  platform: navigator.platform,
});

export const api = {
  async registerFarm(input: {
    farmName: string;
    ownerName: string;
    phone: string;
    password: string;
  }): Promise<{ phone: string; expiresAt: string; devCode?: string }> {
    return request('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async verifyRegistration(phone: string, code: string): Promise<TokenBundle> {
    const bundle = await request<TokenBundle>('/api/v1/auth/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code, ...device() }),
    });
    storeTokens(bundle);
    return bundle;
  },

  async login(phone: string, password: string): Promise<TokenBundle> {
    const bundle = await request<TokenBundle>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ phone, password, ...device() }),
    });
    storeTokens(bundle);
    return bundle;
  },

  async staffLogin(username: string, pin: string): Promise<TokenBundle> {
    const bundle = await request<TokenBundle>('/api/v1/auth/staff-login', {
      method: 'POST',
      body: JSON.stringify({ username, pin, ...device() }),
    });
    storeTokens(bundle);
    return bundle;
  },

  async logout(): Promise<void> {
    const token = refreshToken;
    clearTokens();
    if (!token) return;
    await fetch(`${API_BASE}/api/v1/auth/logout`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: token }),
    }).catch(() => {});
  },

  async profile(): Promise<AuthProfile> {
    return request<AuthProfile>('/api/v1/auth/me');
  },

  async changePin(currentPin: string | undefined, newPin: string): Promise<void> {
    return request<void>('/api/v1/auth/pin', {
      method: 'POST',
      body: JSON.stringify({ ...(currentPin ? { currentPin } : {}), newPin }),
    });
  },

  async listEmployees(): Promise<UserDto[]> {
    const body = await request<{ employees: UserDto[] }>('/api/v1/employees');
    return body.employees;
  },

  async createEmployee(input: CreateEmployeeInput): Promise<EmployeeCreated> {
    return request<EmployeeCreated>('/api/v1/employees', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  },

  async setEmployeeStatus(id: string, status: 'active' | 'suspended'): Promise<UserDto> {
    const action = status === 'suspended' ? 'suspend' : 'reactivate';
    const body = await request<{ employee: UserDto }>(`/api/v1/employees/${id}/${action}`, {
      method: 'POST',
    });
    return body.employee;
  },

  async unlockEmployee(id: string): Promise<void> {
    return request<void>(`/api/v1/employees/${id}/unlock`, { method: 'POST' });
  },

  /** Creates a session from a refresh token already on the device. */
  async restoreSession(): Promise<AuthProfile | null> {
    if (!refreshToken) return null;
    const refreshed = await refreshSession();
    if (!refreshed) return null;
    return api.profile();
  },
};
