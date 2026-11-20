import { matchPath } from "react-router-dom";
import { lazyPage, type LazyPage } from "./lib/lazy-page";

export const LoginPage = lazyPage(() => import("./pages/login"));
export const OverviewPage = lazyPage(() => import("./pages/overview"));
export const UsersPage = lazyPage(() => import("./pages/users"));
export const UserDetailPage = lazyPage(() => import("./pages/user-detail"));
export const OrganizationsPage = lazyPage(() => import("./pages/organizations"));
export const OrganizationDetailPage = lazyPage(() => import("./pages/organization-detail"));
export const SessionsPage = lazyPage(() => import("./pages/sessions"));
export const InvitationsPage = lazyPage(() => import("./pages/invitations"));
export const WaitlistPage = lazyPage(() => import("./pages/waitlist"));

export const SettingsAuthPage = lazyPage(() => import("./pages/settings-auth"));
export const SettingsSocialPage = lazyPage(() => import("./pages/settings-social"));
export const SettingsSessionsPage = lazyPage(() => import("./pages/settings-sessions"));
export const SettingsOrganizationsPage = lazyPage(() => import("./pages/settings-organizations"));
export const SettingsEmailSmsPage = lazyPage(() => import("./pages/settings-email-sms"));
export const SettingsAppearancePage = lazyPage(() => import("./pages/settings-appearance"));
export const RestrictionsPage = lazyPage(() => import("./pages/allow-block-lists"));
export const JwtTemplatesPage = lazyPage(() => import("./pages/jwt-templates"));
export const WebhooksPage = lazyPage(() => import("./pages/webhooks"));
export const ConnectPage = lazyPage(() => import("./pages/connect"));
export const ApiKeysPage = lazyPage(() => import("./pages/api-keys"));
export const M2mPage = lazyPage(() => import("./pages/m2m"));
export const OAuthAppsPage = lazyPage(() => import("./pages/oauth-apps"));
export const EnterpriseSsoPage = lazyPage(() => import("./pages/enterprise-sso"));
export const RolesPage = lazyPage(() => import("./pages/roles-permissions"));
export const AuditLogsPage = lazyPage(() => import("./pages/audit-logs"));

/** Route pattern → page, in the same shape as the `<Routes>` in `App.tsx`. */
const ROUTES: [string, LazyPage][] = [
  ["/login", LoginPage],
  ["/", OverviewPage],
  ["/users", UsersPage],
  ["/users/:id", UserDetailPage],
  ["/organizations", OrganizationsPage],
  ["/organizations/:id", OrganizationDetailPage],
  ["/sessions", SessionsPage],
  ["/invitations", InvitationsPage],
  ["/waitlist", WaitlistPage],
  ["/settings/authentication", SettingsAuthPage],
  ["/settings/social", SettingsSocialPage],
  ["/settings/sessions", SettingsSessionsPage],
  ["/settings/organizations", SettingsOrganizationsPage],
  ["/settings/email-sms", SettingsEmailSmsPage],
  ["/settings/appearance", SettingsAppearancePage],
  ["/restrictions", RestrictionsPage],
  ["/connect", ConnectPage],
  ["/jwt-templates", JwtTemplatesPage],
  ["/webhooks", WebhooksPage],
  ["/api-keys", ApiKeysPage],
  ["/m2m", M2mPage],
  ["/oauth-apps", OAuthAppsPage],
  ["/enterprise-sso", EnterpriseSsoPage],
  ["/roles", RolesPage],
  ["/audit-logs", AuditLogsPage],
];

/** Starts downloading the page a path renders, if it is one of the dashboard's pages. */
export function preloadRoute(pathname: string): void {
  ROUTES.find(([pattern]) => matchPath(pattern, pathname))?.[1].preload();
}
