import { useEffect, useState, type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth.js';
import { syncClient } from '../offline.js';
import { Badge, Button } from './ui.js';

/**
 * The shell every signed-in screen shares: who you are, which module you are
 * in, and whether this phone still owes the server any work.
 */

const NAV = [
  { to: '/', label: 'Home', end: true },
  { to: '/poultry', label: 'Poultry', end: false },
  { to: '/store', label: 'Feed store', end: false },
  { to: '/finance', label: 'Finance', end: false },
];

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
  const { user, farm, online, permissions, signOut } = useAuth();
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

  const canSeeStore =
    permissions.includes('manage_setup') ||
    permissions.includes('receive_stock') ||
    permissions.includes('reserve_feed') ||
    permissions.includes('record_feeding');

  const canSeeFinance =
    permissions.includes('view_finance') || permissions.includes('record_expense');

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-heading">
          <p className="app-eyebrow">{farm?.name ?? 'Your farm'}</p>
          <h1 className="app-title">{title}</h1>
          <p className="app-sub">{subtitle ?? (user ? `${user.name} · ${user.phone}` : '')}</p>
        </div>
        <div className="header-actions">
          <Badge tone={online ? (pending > 0 ? 'amber' : 'green') : 'amber'}>
            {online ? (pending > 0 ? `${pending} to send` : 'Synced') : 'Offline'}
          </Badge>
          <Button variant="ghost" onClick={() => void signOut()}>
            Sign out
          </Button>
        </div>
      </header>

      <nav className="nav" aria-label="Modules">
        {NAV.filter((item) => {
          if (item.to === '/store') return canSeeStore;
          if (item.to === '/finance') return canSeeFinance;
          return true;
        }).map((item) => (
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
    </div>
  );
}
