# example-next

Next.js 14 App Router demo for the whole OrbitID stack: `@orbitid/nextjs` middleware, server
`auth()`, `currentUser()`, SSR-hydrated React components, organizations, a server action, a protected
route handler and a signature-verified webhook endpoint.

## Run

```bash
# terminal 1 — OrbitID server (from the repo root)
bun run dev:server

# terminal 2 — this app
cd apps/example-next
cp .env.example .env.local   # fill in the publishable key and retrieve the secret with orbitid keys
bun run dev
```

Open http://localhost:3000.

## What to look at

| Path | Demonstrates |
|---|---|
| `middleware.ts` | `orbitIdMiddleware` + `createRouteMatcher`; `/dashboard(.*)` and `/user(.*)` protected; `/admin(.*)` requires `org:sys_memberships:manage` |
| `app/layout.tsx` | async `OrbitIDProvider` from `@orbitid/nextjs/server` (SSR hydration + handshake refresh) |
| `app/dashboard/page.tsx` | server component using `auth()` and `currentUser()` |
| `app/dashboard/actions.ts` | `"use server"` action that authenticates and calls the Backend API |
| `app/admin/page.tsx` | permission-protected page that also re-checks with `has()` |
| `app/sign-in/[[...sign-in]]`, `app/sign-up/[[...sign-up]]` | prebuilt `<SignIn/>` / `<SignUp/>` with path routing |
| `app/user/[[...user-profile]]` | prebuilt `<UserProfile/>` |
| `app/dashboard/org` | `<OrganizationProfile/>` + `<CreateOrganization/>` |
| `app/waitlist` | `<Waitlist/>` for waitlist-mode instances |
| `app/oauth-consent` | `<OAuthConsent/>` for OrbitID as an OIDC provider |
| `app/api/me/route.ts` | protected route handler |
| `app/api/webhooks/route.ts` | `verifyWebhook(req)` with signature errors mapped to 400 |

## Environment

See `.env.example`. At minimum set `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY` and
`ORBITID_SECRET_KEY`; set `ORBITID_JWT_KEY` (PEM public key, SPKI or X.509 certificate) to verify
sessions offline in middleware instead of fetching `/.well-known/jwks.json`.

Typecheck without running Next:

```bash
bun run typecheck
```
