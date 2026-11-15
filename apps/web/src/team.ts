import type { UserDto } from '@farmatics/shared';

/**
 * The team list is fetched from the API when a screen has signal and kept on
 * the phone so names still resolve offline. It is a convenience, not a source
 * of truth: a missing or stale cache only costs a friendlier label.
 */

export const TEAM_CACHE = 'farmatics.team';

export function cachedTeam(): UserDto[] {
  try {
    const raw = localStorage.getItem(TEAM_CACHE);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as UserDto[]) : [];
  } catch {
    return [];
  }
}

export function cacheTeam(team: UserDto[]): void {
  try {
    localStorage.setItem(TEAM_CACHE, JSON.stringify(team));
  } catch {
    // A full disk must not break the screen that was only caching names.
  }
}
