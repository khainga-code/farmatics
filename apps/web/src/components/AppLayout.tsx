import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { initialsOf } from '../labels.js';
import { visibleNav } from '../nav.js';
import { syncClient } from '../offline.js';
import { NavIcon } from './icons.js';

/**
 * The shell every signed-in screen shares: where you are, which modules you
 * can open, whether this phone still owes the server any work, and the way
 * back to the account screen. On a phone the modules sit in a thumb-reachable
 * tab bar; on a wide screen they stay as tabs under the heading.
 */

export function AppLayout({
  title,
  subtitle,
  actions,
  children,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { user, farm, online, permissions } = useAuth();
  const [pending, setPending] = useState(0);

  useEffect(() => {
    const read = () => {
      void syncClient.pendingCount().then(setPending);
    };
    read();
    return syncClient.subscribe(read);
  }, []);

  // One sync loop for the whole signed-in app, not one per screen.
  useEffect(() => {
    if (!user) return;
    const stop = syncClient.startLoop({ intervalMs: 30_000 });
    const handleOnline = () => {
      void syncClient.sync();
    };
    window.addEventListener('online', handleOnline);
    if (online) void syncClient.sync();
    return () => {
      stop();
      window.removeEventListener('online', handleOnline);
    };
  }, [user, online]);

  const modules = visibleNav(permissions);
  const syncState = !online ? 'offline' : pending > 0 ? 'pending' : 'synced';
  const syncLabel =
    syncState === 'offline'
      ? 'Offline'
      : syncState === 'pending'
        ? `${pending} to send`
        : 'Synced';

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-heading">
          <p className="app-eyebrow">{farm?.name ?? 'Your farm'}</p>
          <h1 className="app-title">{title}</h1>
          <p className="app-sub">{subtitle ?? (user ? `${user.name} · ${user.phone}` : '')}</p>
        </div>
        <div className="header-actions">
          <Link
            to="/account"
            className={`sync-pill sync-pill--${syncState}`}
            aria-label={
              syncState === 'offline'
                ? 'Offline. Work is saved on this phone. Open account and sync'
                : syncState === 'pending'
                  ? `${pending} record${pending === 1 ? '' : 's'} waiting to send. Open account and sync`
                  : 'Everything is synced. Open account and sync'
            }
          >
            <span className="sync-dot" aria-hidden="true" />
            <span className="sync-text">{syncLabel}</span>
          </Link>
          <Link to="/account" className="avatar" aria-label="Account and settings" title="Account">
            {initialsOf(user?.name)}
          </Link>
        </div>
      </header>

      <nav className="nav" aria-label="Modules">
        {modules.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => (isActive ? 'nav-link nav-link--active' : 'nav-link')}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      {actions && <div className="page-actions">{actions}</div>}

      <main className="app-main">{children}</main>

      <nav className="tabbar" aria-label="Modules">
        {modules.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              isActive ? 'tabbar-link tabbar-link--active' : 'tabbar-link'
            }
          >
            <span className="tabbar-icon">
              <NavIcon name={item.icon} />
            </span>
            <span className="tabbar-label">{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
