import { type ConnectTarget, SECRET_KEY_PLACEHOLDER, type ConnectBlock } from "./model";

const SECRET_KEY_NOTE =
  "The instance secret key. Print it with `orbitid keys`, or set it with ORBITID_SECRET_KEY. The dashboard does not keep it after sign-in.";

const WEBHOOK_NOTE =
  "The webhook secret is per endpoint: open Webhooks, choose the endpoint, and copy its signing secret (whsec_…). Rotating it invalidates the old one immediately.";

const JWT_NOTE =
  "Optional. A PEM public key lets your server verify session tokens offline instead of fetching the JWKS on every cold start.";

/** Values every Next.js app can read in the browser: `NEXT_PUBLIC_*` is inlined at build time. */
export function nextjsBlocks(target: ConnectTarget): ConnectBlock[] {
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

export function reactBlocks(target: ConnectTarget): ConnectBlock[] {
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

export function expressBlocks(target: ConnectTarget): ConnectBlock[] {
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

export function nodeBlocks(target: ConnectTarget): ConnectBlock[] {
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
