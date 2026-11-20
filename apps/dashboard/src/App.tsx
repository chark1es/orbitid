import { Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "./components/layout/app-shell";
import { RequireAuth } from "./lib/auth";
import { RequireOrganizations } from "./components/shared/feature-locked";
import { PageSkeleton } from "./components/shared/page-skeleton";
import { PageFallback } from "./lib/lazy-page";
import {
  ApiKeysPage,
  AuditLogsPage,
  ConnectPage,
  EnterpriseSsoPage,
  InvitationsPage,
  JwtTemplatesPage,
  LoginPage,
  M2mPage,
  OAuthAppsPage,
  OrganizationDetailPage,
  OrganizationsPage,
  OverviewPage,
  preloadRoute,
  RestrictionsPage,
  RolesPage,
  SessionsPage,
  SettingsAppearancePage,
  SettingsAuthPage,
  SettingsEmailSmsPage,
  SettingsOrganizationsPage,
  SettingsSessionsPage,
  SettingsSocialPage,
  UserDetailPage,
  UsersPage,
  WaitlistPage,
  WebhooksPage,
} from "./pages";

/**
 * Starts downloading the first screen while the session check is still in flight: the page at this URL when the
 * console is open, the sign-in page when it is not. Runs once, when the app's code is evaluated.
 */
function preloadFirstScreen() {
  if (typeof window === "undefined") return;
  const here = window.location.pathname;
  const pending = window.__ORBITID_BOOT__?.status;
  if (!pending) {
    preloadRoute(here);
    return;
  }
  pending.then(
    (status) => {
      const open = typeof status === "object" && status !== null && "operator_session" in status && Boolean(status.operator_session);
      if (open) preloadRoute(here);
      else LoginPage.preload();
    },
    () => preloadRoute(here),
  );
}
preloadFirstScreen();

function RouteLoader() {
  return (
    <div className="min-h-svh bg-background">
      <div className="mx-auto w-full max-w-[1280px] px-6 py-10">
        <PageSkeleton rows={2} label="Loading dashboard" />
      </div>
    </div>
  );
}

function NotFound() {
  return (
    <div className="flex flex-col items-center gap-2 py-24 text-center">
      <p className="text-sm font-medium">Page not found</p>
      <p className="text-sm text-muted-foreground">That route does not exist in the dashboard.</p>
    </div>
  );
}

export default function App() {
  return (
    <PageFallback.Provider value={<RouteLoader />}>
      <Suspense fallback={<RouteLoader />}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            element={
              <RequireAuth>
                <AppShell />
              </RequireAuth>
            }
          >
            <Route index element={<OverviewPage />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetailPage />} />
            <Route
              path="organizations"
              element={
                <RequireOrganizations title="Organizations">
                  <OrganizationsPage />
                </RequireOrganizations>
              }
            />
            <Route
              path="organizations/:id"
              element={
                <RequireOrganizations title="Organization">
                  <OrganizationDetailPage />
                </RequireOrganizations>
              }
            />
            <Route path="sessions" element={<SessionsPage />} />
            <Route path="invitations" element={<InvitationsPage />} />
            <Route path="waitlist" element={<WaitlistPage />} />

            <Route path="settings/authentication" element={<SettingsAuthPage />} />
            <Route path="settings/social" element={<SettingsSocialPage />} />
            <Route path="settings/sessions" element={<SettingsSessionsPage />} />
            <Route path="settings/organizations" element={<SettingsOrganizationsPage />} />
            <Route path="settings/email-sms" element={<SettingsEmailSmsPage />} />
            <Route path="settings/appearance" element={<SettingsAppearancePage />} />
            <Route path="restrictions" element={<RestrictionsPage />} />
            <Route path="connect" element={<ConnectPage />} />
            <Route path="jwt-templates" element={<JwtTemplatesPage />} />
            <Route path="webhooks" element={<WebhooksPage />} />
            <Route path="api-keys" element={<ApiKeysPage />} />
            <Route path="m2m" element={<M2mPage />} />
            <Route path="oauth-apps" element={<OAuthAppsPage />} />
            <Route path="enterprise-sso" element={<EnterpriseSsoPage />} />
            <Route path="roles" element={<RolesPage />} />
            <Route path="audit-logs" element={<AuditLogsPage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Suspense>
    </PageFallback.Provider>
  );
}
