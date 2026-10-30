import type { InstanceSettings } from "@orbitid/shared";
import { emailProviderLabel, resolveEmailProvider, secretIsConfigured } from "./settings";

/* ------------------------------------------------------------------------------------------------
 * Frameworks
 * ---------------------------------------------------------------------------------------------- */

export const FRAMEWORKS = [
  { key: "nextjs", label: "Next.js", install: "bun add @orbitid/nextjs" },
  { key: "express", label: "Node (Express)", install: "bun add @orbitid/node express" },
  { key: "node", label: "Plain Node script", install: "bun add @orbitid/node" },
  { key: "react", label: "React + backend", install: "bun add @orbitid/react @orbitid/backend" },
] as const;

export type FrameworkKey = (typeof FRAMEWORKS)[number]["key"];

export const frameworkLabel = (key: FrameworkKey): string => FRAMEWORKS.find((item) => item.key === key)?.label ?? key;
export const frameworkInstall = (key: FrameworkKey): string => FRAMEWORKS.find((item) => item.key === key)?.install ?? "";

/* ------------------------------------------------------------------------------------------------
 * Values the page reads from the instance
 * ---------------------------------------------------------------------------------------------- */

export interface ConnectTarget {
  /** `pk_test_…` / `pk_live_…`, from the public health endpoint. */
  publishableKey: string;
  /** Frontend/Backend API origin the dashboard is pointed at. */
  apiUrl: string;
  /** Sign-in / sign-up paths on the operator's site, derived from the application home URL. */
  homeUrl: string;
  signInUrl: string;
  signUpUrl: string;
}

const trimSlash = (value: string): string => value.trim().replace(/\/+$/, "");

/** `https://app.example.com` → `https://app.example.com/sign-in`. */
export function signInUrlFor(homeUrl: string | undefined, path = "/sign-in"): string {
  const home = trimSlash(homeUrl ?? "");
  return home ? `${home}${path}` : `https://your-app.example.com${path}`;
}

/**
 * The dashboard never holds the secret key after sign-in, so the snippets carry a placeholder and say where
 * the key comes from. Copying a block can then never move a live credential into a chat or a ticket.
 */
export const SECRET_KEY_PLACEHOLDER = "sk_test_…";

export function connectTarget(input: {
  publishableKey: string;
  apiUrl: string;
  homeUrl: string | undefined;
}): ConnectTarget {
  const home = trimSlash(input.homeUrl ?? "");
  return {
    publishableKey: input.publishableKey.trim(),
    apiUrl: trimSlash(input.apiUrl),
    homeUrl: home,
    signInUrl: signInUrlFor(home || undefined, "/sign-in"),
    signUpUrl: signInUrlFor(home || undefined, "/sign-up"),
  };
}

/* ------------------------------------------------------------------------------------------------
 * Copy-ready blocks
 * ---------------------------------------------------------------------------------------------- */

export interface EnvVariable {
  name: string;
  value: string;
  /** Rendered above the variable as a `#` line. */
  comment?: string;
  /** Rendered as a commented-out line: the variable exists but this project does not need it. */
  optional?: boolean;
}

export interface ConnectBlock {
  id: "browser" | "backend";
  heading: string;
  /** One line: where the values go. */
  where: string;
  filename: string;
  variables: EnvVariable[];
  note?: string;
}

export interface ConnectPlan {
  framework: FrameworkKey;
  label: string;
  install: string;
  blocks: ConnectBlock[];
  sample: { title: string; code: string };
}


/** `NAME=value` lines, with `#` comments, suitable for a `.env` file. */
export function renderEnvBlock(block: ConnectBlock): string {
  return block.variables
    .flatMap((variable) => {
      const lines = variable.comment ? [`# ${variable.comment}`] : [];
      const assignment = `${variable.name}=${variable.value}`;
      lines.push(variable.optional ? `# ${assignment}` : assignment);
      return lines;
    })
    .join("\n");
}

/** A block plus its neighbours, so "copy all" can paste a whole file. */
export function renderEnvBlocks(blocks: readonly ConnectBlock[]): string {
  return blocks.map((block) => renderEnvBlock(block)).join("\n\n");
}

/**
 * One labelled block with its heading and destination above it, so a copy pasted into a ticket or a
 * chat keeps the "where this goes" instruction attached.
 */
export function renderBlockWithHeader(block: ConnectBlock): string {
  return [`# ${block.heading}`, `# ${block.where}`, "", renderEnvBlock(block)].join("\n");
}

const SECRET_KEY_NOTE =
  "The instance secret key. Copy it from the server log or <data dir>/keys.json. The dashboard does not keep it after sign-in.";

const WEBHOOK_NOTE =
  "The webhook secret is per endpoint: open Webhooks, choose the endpoint, and copy its signing secret (whsec_…). Rotating it invalidates the old one immediately.";

const JWT_NOTE =
  "Optional. A PEM public key lets your server verify session tokens offline instead of fetching the JWKS on every cold start.";

/** Values every Next.js app can read in the browser: `NEXT_PUBLIC_*` is inlined at build time. */
function nextjsBlocks(target: ConnectTarget): ConnectBlock[] {
  return [
    {
      id: "browser",
      heading: "Website · browser (public)",
      where: "Paste into .env.local at the root of your Next.js app. Next.js inlines NEXT_PUBLIC_* into the browser bundle.",
      filename: ".env.local",
      variables: [
        { name: "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY", value: target.publishableKey },
        { name: "NEXT_PUBLIC_ORBITID_API_URL", value: target.apiUrl },
        { name: "NEXT_PUBLIC_ORBITID_SIGN_IN_URL", value: target.signInUrl },
        { name: "NEXT_PUBLIC_ORBITID_SIGN_UP_URL", value: target.signUpUrl },
      ],
      note:
        "Safe to ship to browsers. The publishable key identifies the instance; it cannot read users or change settings. NEXT_PUBLIC_ORBITID_API_URL is optional: the key already encodes the API URL.",
    },
    {
      id: "backend",
      heading: "Website · backend (secret)",
      where: "Paste into the environment of the server that runs next build and your route handlers. Never prefix these with NEXT_PUBLIC_.",
      filename: ".env (server only)",
      variables: [
        { name: "ORBITID_SECRET_KEY", value: SECRET_KEY_PLACEHOLDER, comment: SECRET_KEY_NOTE },
        { name: "ORBITID_API_URL", value: target.apiUrl },
        { name: "ORBITID_WEBHOOK_SECRET", value: "", comment: WEBHOOK_NOTE },
        { name: "ORBITID_JWT_KEY", value: "", optional: true, comment: JWT_NOTE },
      ],
      note:
        "Anyone with the secret key can read and change every user, session, organization and setting. Keep it in the host's secret store, never in a bundle or a repository.",
    },
  ];
}

function reactBlocks(target: ConnectTarget): ConnectBlock[] {
  return [
    {
      id: "browser",
      heading: "Website · browser (public)",
      where: "Paste into .env.local at the root of your Vite app. Only variables prefixed VITE_ reach the browser.",
      filename: ".env.local",
      variables: [
        { name: "VITE_ORBITID_PUBLISHABLE_KEY", value: target.publishableKey },
        { name: "VITE_ORBITID_SIGN_IN_URL", value: target.signInUrl },
        { name: "VITE_ORBITID_SIGN_UP_URL", value: target.signUpUrl },
      ],
      note: "Safe to ship to browsers. The provider takes these as props, so the names only have to match your build tool's prefix.",
    },
    {
      id: "backend",
      heading: "Website · backend (secret)",
      where: "Paste into your API server's environment. Import @orbitid/backend there, never in the React bundle.",
      filename: ".env (server only)",
      variables: [
        { name: "ORBITID_SECRET_KEY", value: SECRET_KEY_PLACEHOLDER, comment: SECRET_KEY_NOTE },
        { name: "ORBITID_API_URL", value: target.apiUrl },
        { name: "ORBITID_WEBHOOK_SECRET", value: "", comment: WEBHOOK_NOTE },
      ],
      note:
        "The secret key belongs to your server. Everything the browser needs comes from the publishable key, so the React bundle never sees this file.",
    },
  ];
}

function expressBlocks(target: ConnectTarget): ConnectBlock[] {
  return [
    {
      id: "browser",
      heading: "Website · browser (public)",
      where: "Put this in the server environment; the Node SDK exposes it and your page renders it into the browser bootstrap.",
      filename: ".env",
      variables: [
        { name: "ORBITID_PUBLISHABLE_KEY", value: target.publishableKey },
        { name: "ORBITID_API_URL", value: target.apiUrl },
      ],
      note:
        "A public value: it may travel to the browser, but it is read on the server here rather than inlined into a bundle.",
    },
    {
      id: "backend",
      heading: "Website · backend (secret)",
      where: "Paste into the environment that runs your Express server; createOrbitId() reads it at startup.",
      filename: ".env (server only)",
      variables: [
        { name: "ORBITID_SECRET_KEY", value: SECRET_KEY_PLACEHOLDER, comment: SECRET_KEY_NOTE },
        { name: "ORBITID_API_URL", value: target.apiUrl },
        { name: "ORBITID_WEBHOOK_SECRET", value: "", comment: WEBHOOK_NOTE },
      ],
      note: "createOrbitId() throws at boot when the secret key is missing, so a bad deploy fails before it serves traffic.",
    },
  ];
}

function nodeBlocks(target: ConnectTarget): ConnectBlock[] {
  return [
    {
      id: "browser",
      heading: "Website · browser (public)",
      where: "Not used by a script: it talks to the Backend API only. Read this on the server if the same project also serves a browser page.",
      filename: ".env",
      variables: [
        { name: "ORBITID_PUBLISHABLE_KEY", value: target.publishableKey },
        { name: "ORBITID_API_URL", value: target.apiUrl },
      ],
      note: "Public value, and optional here. A script never needs it to call the Backend API.",
    },
    {
      id: "backend",
      heading: "Website · backend (secret)",
      where: "Export these in the shell or the job that runs the script, for example ORBITID_SECRET_KEY=… bun run list-users.",
      filename: "shell environment",
      variables: [
        { name: "ORBITID_SECRET_KEY", value: SECRET_KEY_PLACEHOLDER, comment: SECRET_KEY_NOTE },
        { name: "ORBITID_API_URL", value: target.apiUrl },
        { name: "ORBITID_WEBHOOK_SECRET", value: "", optional: true, comment: WEBHOOK_NOTE },
      ],
      note: "A script that only reads data needs the secret key and the API URL. The webhook secret is only for receivers.",
    },
  ];
}

const SAMPLES: Record<FrameworkKey, { title: string; code: string }> = {
  nextjs: {
    title: "app/layout.tsx",
    code: [
      'import { OrbitIDProvider } from "@orbitid/nextjs/server";',
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      "  return (",
      '    <html lang="en">',
      "      <body>",
      "        <OrbitIDProvider>{children}</OrbitIDProvider>",
      "      </body>",
      "    </html>",
      "  );",
      "}",
    ].join("\n"),
  },
  react: {
    title: "src/App.tsx",
    code: [
      'import { OrbitIDProvider, SignedIn, SignedOut, SignIn, UserButton } from "@orbitid/react";',
      'import "@orbitid/ui/styles.css";',
      "",
      "export function App() {",
      "  return (",
      "    <OrbitIDProvider",
      "      publishableKey={import.meta.env.VITE_ORBITID_PUBLISHABLE_KEY}",
      '      signInUrl={import.meta.env.VITE_ORBITID_SIGN_IN_URL ?? "/sign-in"}',
      "    >",
      "      <SignedIn>",
      "        <UserButton />",
      "      </SignedIn>",
      "      <SignedOut>",
      '        <SignIn routing="path" path="/sign-in" />',
      "      </SignedOut>",
      "    </OrbitIDProvider>",
      "  );",
      "}",
    ].join("\n"),
  },
  express: {
    title: "src/server.ts",
    code: [
      'import express from "express";',
      'import { createOrbitId } from "@orbitid/node";',
      "",
      "const orbit = createOrbitId();",
      "const app = express();",
      "",
      "app.get(\"/me\", orbit.requireAuth(), (req, res) => res.json({ userId: req.auth!.userId }));",
      "app.post(",
      '  "/api/webhooks",',
      '  express.raw({ type: "application/json" }),',
      "  orbit.webhookHandler(async (event) => {",
      '    if (event.type === "user.created") console.log(event.data.id);',
      "  }),",
      ");",
      "",
      "app.listen(3000);",
    ].join("\n"),
  },
  node: {
    title: "list-users.ts",
    code: [
      'import { createOrbitId } from "@orbitid/node";',
      "",
      "const orbit = createOrbitId();",
      "const result = await orbit.client.users.getUserList({ limit: 20, orderBy: \"-created_at\" });",
      "",
      'console.log(`${result.totalCount} users`);',
      "for (const user of result.data) console.log(user.id, user.firstName ?? \"\");",
    ].join("\n"),
  },
};

export function buildConnectPlan(framework: FrameworkKey, target: ConnectTarget): ConnectPlan {
  const blocks =
    framework === "nextjs" ? nextjsBlocks(target)
    : framework === "react" ? reactBlocks(target)
    : framework === "express" ? expressBlocks(target)
    : nodeBlocks(target);
  return {
    framework,
    label: frameworkLabel(framework),
    install: frameworkInstall(framework),
    blocks,
    sample: SAMPLES[framework],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Server summary (read-only)
 * ---------------------------------------------------------------------------------------------- */

export interface ServerSummaryRow {
  label: string;
  value: string;
  detail?: string;
}

/** What this running server is configured with. Never includes the encryption key or any credential. */
export function serverSummary(input: {
  apiUrl: string;
  database: string | null | undefined;
  settings: InstanceSettings | null | undefined;
}): ServerSummaryRow[] {
  const database =
    input.database === "postgres" ? "Postgres"
    : input.database === "sqlite" ? "SQLite"
    : "Reported by /health";
  const rows: ServerSummaryRow[] = [
    {
      label: "Database",
      value: database,
      detail: "The instance's own database. Users, sessions and settings live here.",
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
          ? "Codes are printed to the server log. Configure a provider before production."
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
            ? "Mail is printed to the server log. Sign-in codes will not reach users."
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
