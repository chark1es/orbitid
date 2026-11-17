import type { InstanceSettings } from "@orbitid/shared";
import { emailProviderLabel, resolveEmailProvider, secretIsConfigured } from "../settings";

export interface ServerSummaryRow {
  label: string;
  value: string;
  detail?: string;
}

/** What this running server is configured with. Never includes the encryption key or any credential. */
export function serverSummary(input: {
  apiUrl: string;
  database: string | null | undefined;
  /** `/health`'s `database_driver`; newer servers report `postgres`. */
  databaseDriver?: string | null;
  settings: InstanceSettings | null | undefined;
}): ServerSummaryRow[] {
  const database =
    input.database === "postgres" ? "Postgres"
    : input.database === "sqlite" ? "SQLite (unsupported)"
    : "Reported by /health";
  const databaseDetail =
    input.database === "sqlite"
      ? "This server still runs SQLite. The current server requires Postgres; move the data before upgrading (docs/DATA_MOVE.md)."
      : input.database === "postgres"
        ? `The instance's own Postgres database${input.databaseDriver ? ` (driver: ${input.databaseDriver})` : ""}. Users, sessions, settings and uploads live here.`
        : "The instance's own database. Users, sessions, settings and uploads live here.";
  const rows: ServerSummaryRow[] = [
    {
      label: "Database",
      value: database,
      detail: databaseDetail,
    },
    { label: "Base URL", value: input.apiUrl, detail: "The origin the SDKs and these snippets point at." },
  ];
  if (input.settings) {
    const resolved = resolveEmailProvider(input.settings.email);
    rows.push({
      label: "Email delivery",
      value: emailProviderLabel(resolved.provider),
      detail:
        resolved.provider === "console"
          ? "Email delivery is disabled. Configure Resend or SMTP before enabling email sign-in."
          : resolved.automatic
            ? "Automatic: the first configured transport is used. Environment variables fill an empty setting."
            : "Selected explicitly in Email & SMS. Environment variables fill an empty setting.",
    });
    rows.push({
      label: "Private networks",
      value: input.settings.application.developmentMode ? "Allowed" : "Blocked",
      detail: input.settings.application.developmentMode
        ? "Development mode is on, so outbound calls may reach localhost and private addresses."
        : "Outbound calls to localhost and private addresses are refused unless ORBITID_ALLOW_PRIVATE_NETWORKS=true is set on the server.",
    });
  }
  return rows;
}

/* ------------------------------------------------------------------------------------------------
 * Setup check
 * ---------------------------------------------------------------------------------------------- */

export type CheckState = "ok" | "warn" | "fail";

export interface SetupCheck {
  id: string;
  label: string;
  state: CheckState;
  detail: string;
}

export interface SetupCheckInput {
  apiUrl: string;
  health: { status: string; publishableKey: string; database: string | null } | null;
  healthError: string | null;
  environment: { firstFactors: string[]; signUpMode: string; applicationName: string } | null;
  environmentError: string | null;
  publishableKey: string;
  /** True when the dashboard has a live operator session, i.e. the Backend API calls behind the page work. */
  sessionActive: boolean;
  settings: InstanceSettings | null;
}

const FACTOR_LABELS: Record<string, string> = {
  password: "password",
  email_code: "email code",
  email_link: "email link",
  phone_code: "SMS code",
  passkey: "passkey",
  reset_password_email_code: "password reset",
  reset_password_phone_code: "SMS password reset",
};

/** Title case for a raw strategy such as `oauth_google`. */
function factorLabel(strategy: string): string {
  if (FACTOR_LABELS[strategy]) return FACTOR_LABELS[strategy]!;
  if (strategy.startsWith("oauth_")) return strategy.slice("oauth_".length).replace(/_/g, " ");
  if (strategy.startsWith("enterprise_sso")) return "enterprise SSO";
  return strategy.replace(/_/g, " ");
}

export function setupChecks(input: SetupCheckInput): SetupCheck[] {
  const checks: SetupCheck[] = [];

  if (input.healthError) {
    checks.push({
      id: "health",
      label: "Server reachable",
      state: "fail",
      detail: `GET ${input.apiUrl}/health failed: ${input.healthError}. Start the server at that address, or sign out and point the dashboard at another instance.`,
    });
  } else if (input.health) {
    checks.push({
      id: "health",
      label: "Server reachable",
      state: input.health.status === "ok" ? "ok" : "warn",
      detail: `GET ${input.apiUrl}/health answered "${input.health.status}"${input.health.database ? ` on ${input.health.database}` : ""}.`,
    });
    if (input.health.database === "sqlite") {
      checks.push({
        id: "database",
        label: "Supported database",
        state: "fail",
        detail:
          "This instance reports SQLite, which the current server no longer supports. Move it to Postgres with the last TypeScript release's copy command, then run the Rust server against that database.",
      });
    }
  } else {
    checks.push({ id: "health", label: "Server reachable", state: "warn", detail: "Not checked yet." });
  }

  const key = input.publishableKey || input.health?.publishableKey || "";
  checks.push({
    id: "publishable-key",
    label: "Publishable key",
    state: key ? "ok" : "fail",
    detail: key
      ? "The instance serves a publishable key, so a browser can start the SDK."
      : "No publishable key came back. Check that the server finished starting.",
  });

  checks.push({
    id: "operator-session",
    label: "Dashboard session",
    state: input.sessionActive ? "ok" : "warn",
    detail: input.sessionActive
      ? "Signed in with an httpOnly session cookie. The browser never holds the secret key; snippets use a placeholder."
      : "No live dashboard session, so the Backend API calls behind this page cannot run. Sign in again.",
  });

  if (input.environmentError) {
    checks.push({
      id: "environment",
      label: "Sign-in methods published",
      state: "fail",
      detail: `GET ${input.apiUrl}/v1/client/environment failed: ${input.environmentError}.`,
    });
  } else if (input.environment) {
    const factors = input.environment.firstFactors.map(factorLabel);
    checks.push({
      id: "environment",
      label: "Sign-in methods published",
      state: factors.length > 0 ? "ok" : "warn",
      detail:
        factors.length > 0
          ? `${input.environment.applicationName} accepts ${factors.join(", ")}; sign-up mode is ${input.environment.signUpMode}.`
          : "No first factor is enabled, so nobody can sign in yet. Turn on a method in Authentication.",
    });
  }

  if (input.settings) {
    const email = resolveEmailProvider(input.settings.email);
    checks.push({
      id: "email",
      label: "Email delivery",
      state: email.provider === "console" || email.missing ? "warn" : "ok",
      detail:
        email.missing
          ? `${emailProviderLabel(email.provider)} is selected without a credential, so sends fail.`
          : email.provider === "console"
            ? "Email delivery is disabled. Configure Resend or SMTP so sign-in codes reach users."
            : `Mail leaves through ${emailProviderLabel(email.provider)}. Send a test from Email & SMS to confirm.`,
    });

    const home = input.settings.application.homeUrl;
    const origins = [...input.settings.application.allowedOrigins, ...input.settings.application.allowedRedirectOrigins];
    let homeOrigin = "";
    try {
      homeOrigin = new URL(home).origin;
    } catch {
      homeOrigin = "";
    }
    const allowed = homeOrigin !== "" && (origins.includes(homeOrigin) || input.settings.application.developmentMode);
    checks.push({
      id: "origins",
      label: "Application home URL allowed",
      state: homeOrigin === "" ? "warn" : allowed ? "ok" : "warn",
      detail:
        homeOrigin === ""
          ? "No application home URL is set. Set it in Email & SMS (Application identity) so redirects and sign-in URLs resolve."
          : allowed
            ? `${homeOrigin} may send browser requests and receive redirects.`
            : `${homeOrigin} is not in Allowed origins. Add it under Restrictions, or redirects and browser calls are refused.`,
    });

    if (!secretIsConfigured(input.settings.email.resendApiKey) && !secretIsConfigured(input.settings.email.smtpUrl) && input.settings.email.provider !== "console") {
      checks.push({
        id: "env-email",
        label: "Email environment fallback",
        state: "warn",
        detail:
          "No transport credential is stored. If ORBITID_RESEND_API_KEY or ORBITID_SMTP_URL is set on the server, delivery still works; this page cannot see those variables.",
      });
    }
  }

  return checks;
}
