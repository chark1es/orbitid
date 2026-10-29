// Server-rendered page for the OAuth 2.0 device grant verification URI (`GET /oauth/device`).
//
// No framework and no inline script or style: everything the page needs is served from this origin under a
// strict Content-Security-Policy, and every interpolated value is escaped. Another worker owns the global
// security-header middleware, so the policy is set by the handler that renders the page.
import { escapeHtml } from "../lib/html";

export const DEVICE_PAGE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "connect-src 'none'",
  "img-src 'self' data:",
  "form-action 'self'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

export interface DevicePageInput {
  signedIn: boolean;
  signInHref: string;
  code: string | null;
  appName: string | null;
  scopes: string[];
  scopesWithDescriptions?: { scope: string; description: string }[];
  state: "enter_code" | "not_found" | "expired" | "already_decided" | "sign_in_required" | "consent";
}

const shell = (ctx: { title: string; product: string; body: string }) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(ctx.title)}</title>
<link rel="stylesheet" href="/oauth/device.css">
</head>
<body>
<main class="card">
<p class="brand">${escapeHtml(ctx.product)}</p>
${ctx.body}
</main>
<script src="/oauth/device.js" defer></script>
</body>
</html>`;

const scopeList = (scopes: { scope: string; description: string }[]) =>
  `<ul class="scopes">${scopes.map((s) => `<li><strong>${escapeHtml(s.scope)}</strong> <span>${escapeHtml(s.description)}</span></li>`).join("")}</ul>`;

const codeForm = (code: string | null) => `<form method="post" action="/oauth/device" class="code-form">
<label for="user_code">Enter the code shown on your device</label>
<input id="user_code" name="user_code" class="code-input" inputmode="text" autocomplete="off" autocapitalize="characters"
  spellcheck="false" maxlength="9" placeholder="ABCD-EFGH" value="${escapeHtml(code ?? "")}" required>
<button type="submit" name="action" value="continue" class="secondary">Continue</button>
</form>`;

/**
 * Renders the verification page for the given state. `product` is the instance name, never user input.
 */
export function devicePageHtml(input: DevicePageInput, product = "OrbitID"): string {
  const title = `Connect a device — ${product}`;
  const intro = `<h1>Connect a device</h1>`;
  // Signed out: the user has to sign in before anything can be approved, so the link is always offered.
  const signInLink = input.signedIn
    ? ""
    : `<p class="muted">You are not signed in.</p><p><a class="button" href="${escapeHtml(input.signInHref)}">Sign in</a></p>`;
  switch (input.state) {
    case "enter_code":
      return shell({
        title, product,
        body: `${intro}<p class="muted">Enter the code shown on the device you want to connect.</p>${signInLink}${codeForm(null)}`,
      });
    case "not_found":
      return shell({
        title, product,
        body: `${intro}<p class="error">That code is not valid. Check the device screen and try again.</p>${signInLink}${codeForm(input.code)}`,
      });
    case "expired":
      return shell({
        title, product,
        body: `${intro}<p class="error">That code has expired. Start again from your device to get a new one.</p>${signInLink}${codeForm(null)}`,
      });
    case "already_decided":
      return shell({
        title, product,
        body: `${intro}<p class="error">That code has already been used. Start again from your device to get a new one.</p>${signInLink}`,
      });
    case "sign_in_required":
      return shell({
        title, product,
        body: `${intro}
<p><strong>${escapeHtml(input.appName ?? "An application")}</strong> wants to connect to your account.</p>
${signInLink}
${codeForm(input.code)}`,
      });
    case "consent": {
      const scopes = input.scopesWithDescriptions ?? input.scopes.map((scope) => ({ scope, description: `Access to ${scope}` }));
      return shell({
        title, product,
        body: `${intro}
<p><strong>${escapeHtml(input.appName ?? "An application")}</strong> wants to connect to your account.</p>
<p class="muted">It is asking for:</p>
${scopeList(scopes)}
<form method="post" action="/oauth/device" class="decision-form">
<input type="hidden" name="user_code" value="${escapeHtml(input.code ?? "")}">
<button type="submit" name="action" value="approve">Allow</button>
<button type="submit" name="action" value="deny" class="secondary">Deny</button>
</form>
<p class="muted small">Only continue if you started this request yourself.</p>`,
      });
    }
  }
}

/** Terminal page shown after a decision (or after too many wrong codes). */
export function deviceResultHtml(
  state: "approved" | "denied" | "too_many_attempts" | "cross_site",
  appName?: string,
  product = "OrbitID",
): string {
  const title = `Connect a device — ${product}`;
  switch (state) {
    case "approved":
      return shell({
        title, product,
        body: `<h1>Device connected</h1><p><strong>${escapeHtml(appName ?? "The application")}</strong> can now use your account. You can close this window.</p>`,
      });
    case "denied":
      return shell({
        title, product,
        body: `<h1>Request denied</h1><p>The device was not given access. You can close this window.</p>`,
      });
    case "too_many_attempts":
      return shell({
        title, product,
        body: `<h1>Too many attempts</h1><p>That code is no longer valid. Start again from your device to get a new one.</p>`,
      });
    case "cross_site":
      return shell({
        title, product,
        body: `<h1>Request blocked</h1><p>Open the verification link from this site to continue.</p>`,
      });
  }
}
