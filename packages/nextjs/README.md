# `@orbitid/nextjs`

Next.js 14+ integration for OrbitID.

- `orbitIdMiddleware` / `createRouteMatcher`
- `auth()` with `protect()`, `currentUser()`, `getAuth()` (Pages Router)
- `<OrbitIDProvider>` server wrapper with SSR hydration of `useAuth()`
- `@orbitid/nextjs/webhooks` for Svix-compatible webhook verification
- Re-exports the full `@orbitid/react` surface (components, hooks, controls)

## Environment

| Variable | Where | Purpose |
|---|---|---|
| `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY` | client + server | `pk_test_…`; encodes the Frontend API URL |
| `NEXT_PUBLIC_ORBITID_API_URL` | server | Backend API URL override (falls back to the key's URL) |
| `NEXT_PUBLIC_ORBITID_SIGN_IN_URL` | client + server | default `/sign-in` |
| `NEXT_PUBLIC_ORBITID_SIGN_UP_URL` | client + server | default `/sign-up` |
| `NEXT_PUBLIC_ORBITID_AFTER_SIGN_IN_URL` | client | default fallback redirect `/` |
| `NEXT_PUBLIC_ORBITID_AFTER_SIGN_UP_URL` | client | default fallback redirect `/` |
| `ORBITID_SECRET_KEY` | server | `sk_test_…` for `currentUser()` / `orbitIdClient()` |
| `ORBITID_JWT_KEY` | server/middleware | PEM public key for offline `__session` verification |
| `ORBITID_AUTHORIZED_PARTIES` | server/middleware | comma-separated origins checked against `azp` |
| `ORBITID_WEBHOOK_SECRET` | server | default `whsec_…` for `verifyWebhook()` |

Without `ORBITID_JWT_KEY`, middleware verifies tokens through `${apiUrl}/.well-known/jwks.json`.

## App Router

```tsx
// app/layout.tsx
import { OrbitIDProvider } from '@orbitid/nextjs/server';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OrbitIDProvider>{children}</OrbitIDProvider>
      </body>
    </html>
  );
}
```

`OrbitIDProvider` is an async server component: it calls `auth()` and passes `initialState` to the
client provider, so `useAuth()` is correct on the first render. When middleware still reports a
`handshake` (expired `__session` with a live `__client_uat` on a request the middleware did not
redirect, or when the handshake is disabled), it mounts `<HandshakeRefresher/>`, which waits for the
SDK to mint a token and calls `router.refresh()` once.

### Middleware

```ts
// middleware.ts
import { createRouteMatcher, orbitIdMiddleware } from '@orbitid/nextjs/server';

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/api/:path*']);
const isAdminRoute = createRouteMatcher(['/admin(.*)']);

export default orbitIdMiddleware(async (auth, req) => {
  if (isAdminRoute(req)) {
    await auth.protect({ permission: 'org:sys_memberships:manage', unauthorizedUrl: '/dashboard' });
  }
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export const config = { matcher: ['/((?!_next|.*\\.(?:svg|png|jpe?g|gif|ico|webp|woff2?|css|js|map|txt|xml)$).*)'] };
```

Plain mode (no handler) only attaches auth state to the request:

```ts
export default orbitIdMiddleware({ debug: true });
```

Options: `publishableKey`, `secretKey`, `jwtKey`, `authorizedParties`, `signInUrl`, `signUpUrl`,
`debug`, `contentSecurityPolicy` (`string` or `{ directives, reportOnly, reportUri, nonce }`).

### Route protection

```ts
import { createRouteMatcher } from '@orbitid/nextjs/server';

createRouteMatcher(['/dashboard(.*)']);          // route groups
createRouteMatcher(['/api/:id']);                // one segment
createRouteMatcher(['/api/:path*']);             // catch-all, also matches /api
createRouteMatcher(['/admin/**']);               // glob
createRouteMatcher([/^\/account(\/|$)/]);        // RegExp
createRouteMatcher((req) => req.nextUrl.pathname.startsWith('/private'));
```

`auth.protect()` variants:

```ts
await auth.protect();                                   // signed-in only
await auth.protect({ role: 'org:admin' });              // role check
await auth.protect({ permission: 'org:sys_domains:manage' });
await auth.protect({ has: (a) => a.orgSlug === 'acme' });// custom predicate
await auth.protect({ unauthorizedUrl: '/no-access' });  // signed-in, no access
```

Signed-out users are redirected to the sign-in URL with `?redirect_url=<current URL>`. Signed-in
users without the required role/permission get `notFound()` (404) unless `unauthorizedUrl` is set.

### Server components, route handlers, server actions

```tsx
import { auth, currentUser } from '@orbitid/nextjs/server';

export default async function Page() {
  const { userId, orgId, orgRole, has } = await auth();
  const user = userId ? await currentUser() : null;   // cached per request
  if (!has({ permission: 'org:sys_memberships:manage' })) notFound();
  return <p>{user?.firstName ?? userId}</p>;
}
```

```ts
// app/api/me/route.ts
import { auth } from '@orbitid/nextjs/server';

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated) return new Response('Unauthorized', { status: 401 });
  return Response.json({ userId: session.userId, orgId: session.orgId });
}
```

```ts
'use server';
import { auth } from '@orbitid/nextjs/server';

export async function action() {
  const { userId } = await auth();
  if (!userId) throw new Error('Unauthorized');
  // ...
}
```

### Pages Router

```ts
import type { GetServerSideProps } from 'next';
import { getAuth } from '@orbitid/nextjs/server';

export const getServerSideProps: GetServerSideProps = async (ctx) => {
  const { userId, has } = await getAuth(ctx);
  if (!userId) return { redirect: { destination: '/sign-in', permanent: false } };
  return { props: { isAdmin: has({ role: 'org:admin' }) } };
};
```

### Webhooks

```ts
// app/api/webhooks/route.ts
import { verifyWebhook } from '@orbitid/nextjs/webhooks';

export async function POST(req: Request) {
  const event = await verifyWebhook(req);            // throws WebhookVerificationError
  if (event.type === 'user.created') console.log(event.data);
  return Response.json({ received: true });
}
```

Pass a secret explicitly with `verifyWebhook(req, 'whsec_…')` or set `ORBITID_WEBHOOK_SECRET`.
Signatures use `svix-id`, `svix-timestamp` and `svix-signature` with a 5-minute tolerance.

## Auth semantics

- Token source order: `Authorization: Bearer` → `__session` cookie.
- The middleware verifies the JWT offline (`ORBITID_JWT_KEY`) or via JWKS, checks `azp` against
  `authorizedParties`, and forwards `x-orbitid-auth-status|token|reason|url` to the app.
- `__session` expired (or missing) + `__client_uat > 0` on a top-level navigation → the middleware
  sends the browser through `GET /v1/client/handshake` on the Frontend API, verifies the returned
  `__orbit_handshake` token and writes `__session` / `__client_uat` before continuing. See
  [docs/HANDSHAKE.md](../../docs/HANDSHAKE.md). Other requests keep the `handshake` state: server code
  sees a signed-out session while `<HandshakeRefresher/>` refreshes the client token and reloads the
  RSC tree.
- `auth()` returns the shared `AuthObject` (`userId`, `sessionId`, `orgId`, `orgRole`, `orgSlug`,
  `orgPermissions`, `actor`, `sessionClaims`, `sessionStatus`, `isAuthenticated`, `getToken`,
  `has`) plus `protect()` and `redirectToSignIn()`.

## Exports

| Entry point | Exports |
|---|---|
| `@orbitid/nextjs` | everything from `@orbitid/react`, `ClientOrbitIDProvider` (also `OrbitIDProvider`), `HandshakeRefresher`, auth types, `getPublicEnv` |
| `@orbitid/nextjs/server` | `auth`, `currentUser`, `getAuth`, `orbitIdClient`, `orbitIdMiddleware`, `createRouteMatcher`, `OrbitIDProvider` (server), `verifyWebhook`, `redirectToSignIn`, `redirectToSignUp`, `completeHandshake`, `buildHandshakeUrl`, `isNavigationRequest` |
| `@orbitid/nextjs/webhooks` | `verifyWebhook`, `WebhookVerificationError` |
