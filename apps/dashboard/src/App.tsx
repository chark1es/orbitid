import { lazy, Suspense } from "react";
import { Route, Routes } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { AppShell } from "./components/layout/app-shell";
import { RequireAuth } from "./lib/auth";

const LoginPage = lazy(() => import("./pages/login"));
const OverviewPage = lazy(() => import("./pages/overview"));
const UsersPage = lazy(() => import("./pages/users"));
const UserDetailPage = lazy(() => import("./pages/user-detail"));
const OrganizationsPage = lazy(() => import("./pages/organizations"));
const OrganizationDetailPage = lazy(() => import("./pages/organization-detail"));
const SessionsPage = lazy(() => import("./pages/sessions"));
const InvitationsPage = lazy(() => import("./pages/invitations"));
const WaitlistPage = lazy(() => import("./pages/waitlist"));

const SettingsAuthPage = lazy(() => import("./pages/settings-auth"));
const SettingsSocialPage = lazy(() => import("./pages/settings-social"));
const SettingsSessionsPage = lazy(() => import("./pages/settings-sessions"));
const SettingsOrganizationsPage = lazy(() => import("./pages/settings-organizations"));
const SettingsEmailSmsPage = lazy(() => import("./pages/settings-email-sms"));
const SettingsAppearancePage = lazy(() => import("./pages/settings-appearance"));
const RestrictionsPage = lazy(() => import("./pages/allow-block-lists"));
const JwtTemplatesPage = lazy(() => import("./pages/jwt-templates"));
const WebhooksPage = lazy(() => import("./pages/webhooks"));
const ConnectPage = lazy(() => import("./pages/connect"));
const ApiKeysPage = lazy(() => import("./pages/api-keys"));
const M2mPage = lazy(() => import("./pages/m2m"));
const OAuthAppsPage = lazy(() => import("./pages/oauth-apps"));
const EnterpriseSsoPage = lazy(() => import("./pages/enterprise-sso"));
const RolesPage = lazy(() => import("./pages/roles-permissions"));
const AuditLogsPage = lazy(() => import("./pages/audit-logs"));

function RouteLoader() {
  return (
    <div className="flex min-h-svh items-center justify-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" aria-hidden /> Loading dashboard…
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
          <Route path="organizations" element={<OrganizationsPage />} />
          <Route path="organizations/:id" element={<OrganizationDetailPage />} />
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
  );
}
