import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import type { Permission } from '@farmatics/shared';
import { useAuth } from './auth.js';
import { LockScreen } from './components/LockScreen.js';
import { BatchPage } from './pages/BatchPage.js';
import { DashboardPage } from './pages/DashboardPage.js';
import { FinancePage } from './pages/FinancePage.js';
import { HealthPage } from './pages/HealthPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { PoultryPage } from './pages/PoultryPage.js';
import { RegisterPage } from './pages/RegisterPage.js';
import { SalesPage } from './pages/SalesPage.js';
import { StaffLoginPage } from './pages/StaffLoginPage.js';
import { StorePage } from './pages/StorePage.js';
import { VerifyPage } from './pages/VerifyPage.js';

function Boot() {
  return (
    <div className="boot">
      <span className="spinner" aria-label="Loading" />
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading, locked } = useAuth();
  if (loading) return <Boot />;
  if (!user) return <Navigate to="/login" replace />;
  if (locked) return <LockScreen />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) return <Boot />;
  if (user) return <Navigate to="/" replace />;
  return <>{children}</>;
}

/**
 * A hidden nav item is not a guard: someone can type the address. Screens that
 * expose a restricted area refuse to open here as well.
 */
function RequirePermission({
  anyOf,
  children,
}: {
  anyOf: Permission[];
  children: ReactNode;
}) {
  const { can } = useAuth();
  if (!anyOf.some((permission) => can(permission))) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

export function App() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <RequireAuth>
            <DashboardPage />
          </RequireAuth>
        }
      />
      <Route
        path="/poultry"
        element={
          <RequireAuth>
            <PoultryPage />
          </RequireAuth>
        }
      />
      <Route
        path="/poultry/:batchId"
        element={
          <RequireAuth>
            <BatchPage />
          </RequireAuth>
        }
      />
      <Route
        path="/health"
        element={
          <RequireAuth>
            <RequirePermission anyOf={['record_mortality', 'view_reports']}>
              <HealthPage />
            </RequirePermission>
          </RequireAuth>
        }
      />
      <Route
        path="/store"
        element={
          <RequireAuth>
            <StorePage />
          </RequireAuth>
        }
      />
      <Route
        path="/sales"
        element={
          <RequireAuth>
            <SalesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/finance"
        element={
          <RequireAuth>
            <RequirePermission anyOf={['view_finance', 'record_expense']}>
              <FinancePage />
            </RequirePermission>
          </RequireAuth>
        }
      />
      <Route
        path="/login"
        element={
          <PublicOnly>
            <LoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/staff"
        element={
          <PublicOnly>
            <StaffLoginPage />
          </PublicOnly>
        }
      />
      <Route
        path="/register"
        element={
          <PublicOnly>
            <RegisterPage />
          </PublicOnly>
        }
      />
      <Route
        path="/verify"
        element={
          <PublicOnly>
            <VerifyPage />
          </PublicOnly>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
