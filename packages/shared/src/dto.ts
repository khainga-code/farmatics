import type { Permission, Role } from './permissions.js';

/**
 * Shapes sent between the API and the app. Defined once so a field rename
 * breaks the build in both places instead of at runtime.
 */

export interface UserDto {
  id: string;
  farmId: string;
  name: string;
  phone: string;
  username: string | null;
  role: Role;
  status: 'active' | 'suspended';
  mustChangePin: boolean;
  lastLoginAt: string | null;
}

export interface FarmDto {
  id: string;
  name: string;
  currency: string;
  offlineDaysAllowed: number;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresIn: number;
  user: UserDto;
  permissions: Permission[];
  deviceId: string;
}

export interface AuthProfile {
  user: UserDto;
  permissions: Permission[];
  farm: FarmDto;
}

export interface EmployeeCreated {
  user: UserDto;
  tempPin: string;
}
