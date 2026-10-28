# @orbitid/react

React bindings for OrbitID: the provider, hooks, control components, and the shared appearance /
localization infrastructure used by the prebuilt auth and organization UI.

```tsx
import { OrbitIDProvider, SignedIn, SignedOut, SignIn, UserButton } from "@orbitid/react";
import "@orbitid/ui/styles.css"; // Tailwind v4 tokens consumed by every component

export function App() {
  return (
    <OrbitIDProvider publishableKey={import.meta.env.VITE_ORBITID_PUBLISHABLE_KEY} afterSignOutUrl="/">
      <header>
        <SignedIn>
          <UserButton />
        </SignedIn>
        <SignedOut>
          <SignIn routing="path" path="/sign-in" />
        </SignedOut>
      </header>
    </OrbitIDProvider>
  );
}
```

`import "@orbitid/ui/styles.css"` is required: components are styled with the shadcn variables
(`--primary`, `--background`, `--foreground`, `--destructive`, `--radius`, …) that file defines.

## `<OrbitIDProvider/>`

Creates one `@orbitid/js` `OrbitID` instance per publishable key (StrictMode-safe), loads it once,
subscribes to its listener, and publishes every context below. Safe during SSR: nothing touches
`window` at render time.

| Prop | Purpose |
|---|---|
| `publishableKey` | `pk_test_…` / `pk_live_…`; required unless `orbit` is passed |
| `orbit` | Pre-built `OrbitID` instance (tests, custom runtimes) |
| `initialState` | SSR hydration payload: `{ sessionClaims, session, user, organization, userId, sessionId, orgId, orgRole, orgSlug, orgPermissions }` |
| `appearance` | `{ baseTheme, variables, layout, elements }` |
| `localization` | Deep-partial `LocalizationResource` merged over `enUS`, or `false` |
| `routerPush` / `routerReplace` | Navigation callbacks (Next.js `useRouter`), also forwarded to the SDK |
| `signInUrl`, `signUpUrl`, `userProfileUrl`, `organizationProfileUrl`, `createOrganizationUrl` | Component routes used by the `RedirectTo*` components |
| `signInFallbackRedirectUrl`, `signUpFallbackRedirectUrl`, `signInForceRedirectUrl`, `signUpForceRedirectUrl`, `afterSignOutUrl` | Redirect precedence (force → validated `redirect_url` → fallback → default) |
| `allowedRedirectOrigins` | Extra origins (strings or `RegExp`) accepted as `redirect_url` targets |

Contexts: `OrbitIDContext`, `ClientContext`, `SessionContext`, `UserContext`,
`OrganizationContext`, `AuthContext`, `OrbitIDOptionsContext` (`OptionsContext`), `AppearanceContext`,
`LocalizationContext`, `StatusContext`, `ReverificationContext`.

## Hooks

| Hook | Returns |
|---|---|
| `useOrbitID()` | the SDK instance |
| `useAuth()` | `{ isLoaded, isSignedIn, userId, sessionId, actor, orgId, orgRole, orgSlug, orgPermissions, sessionClaims, sessionStatus, has, getToken, signOut }` |
| `useUser()` | `{ isLoaded, isSignedIn, user }` |
| `useSession()` | `{ isLoaded, isSignedIn, session }` |
| `useSessionList()` | `{ isLoaded, sessions, setActive, signOut }` |
| `useSignIn()` / `useSignUp()` | `{ isLoaded, signIn \| signUp, setActive }` |
| `useOrganization(params)` | `{ isLoaded, organization, membership, memberships, invitations, domains, membershipRequests, apiKeys }` |
| `useOrganizationList(params)` | `{ isLoaded, userMemberships, userInvitations, userSuggestions, setActive, createOrganization }` |
| `useReverification(fetcher)` | wrapped fetcher that handles `session_reverification_required` |
| `useOrbitIDStatus()` | `{ isLoaded, isSignedIn, status: "loading" \| "signed-in" \| "signed-out" }` |
| `useAppearance()` / `useElementClasses(name)` | merged appearance, per-element class helper |
| `useLocalizations()` | `{ locale, resource, t }` |

`has()` accepts exactly one of `role`, `permission`, `feature`, `condition`, `reverification`
(`"strict_mfa" | "strict" | "moderate" | "lax"` or `{ level, afterMinutes }`).

Paginated resources return this shape:

```ts
{
  data, count, page, pageCount,
  isLoading, isFetching, isInitialLoading,
  hasNextPage, hasPreviousPage,
  fetchNext(), fetchPrevious(), revalidate(), setData(data),
  error,
}
```

```tsx
const { memberships } = useOrganization({ memberships: { pageSize: 20, infinite: true } });
await memberships.fetchNext();
```

Membership, invitation and suggestion requests are keyed by resource and user. Components that
mount together share one in-flight request, and a response is reused for a few seconds, so
`<UserButton/>`, `<OrganizationSwitcher/>`, `<OrganizationList/>` and `<UserProfile/>` on the same
page issue each GET once. `revalidate()` bypasses the cache and replaces the current page;
creating, accepting, leaving or updating an organization invalidates the affected entries.

## Control components

`<SignedIn>`, `<SignedOut>`, `<Protect role permission feature condition fallback>`,
`<RedirectToSignIn>`, `<RedirectToSignUp>`, `<RedirectToUserProfile>`,
`<RedirectToOrganizationProfile>`, `<RedirectToCreateOrganization>`,
`<AuthenticateWithRedirectCallback>`, `<OrbitIDLoaded>`, `<OrbitIDLoading>`, `<OrbitIDFailed>`,
`<MultisessionAppSupport>`.

`<Protect>` renders `fallback` (default `null`) while the instance loads and when the check fails.

## Appearance

```tsx
<OrbitIDProvider
  appearance={{
    baseTheme: [dark],
    variables: { colorPrimary: "#4f46e5", borderRadius: "0.75rem", fontFamily: "Inter, sans-serif" },
    layout: { socialButtonsVariant: "iconButton", logoPlacement: "inside" },
    elements: { card: "shadow-xl", formButtonPrimary: "rounded-full" },
  }}
>
```

* Tokens map onto the shadcn variables: `colorPrimary → --primary`, `colorBackground → --background`,
  `colorText → --foreground`, `colorDanger → --destructive`, `borderRadius → --radius`, plus
  `--orbitid-*` aliases for the rest. Unknown tokens become `--orbitid-<kebab-key>`.
* `--primary-foreground` is derived from `colorPrimary` (hex colors) for legible button text.
* Themes: `defaultTheme`, `dark`. Arrays merge in order; `appearance` wins over the theme.
* The provider renders `<div className="orbitid-root …">` carrying the CSS variables; `rootBox`
  overrides are applied to that wrapper.
* Components resolve element classes with `useElementClasses("card")(...defaults)`; user overrides
  win over component defaults (`tailwind-merge` semantics).

## Localization

```tsx
import { enUS, de, type LocalizationResource } from "@orbitid/react";

<OrbitIDProvider localization={de} … />
```

`t(path, vars)` interpolates `{{placeholders}}` (unknown placeholders stay visible), resolves
active locale → `enUS` → the dot-path, and `useLocalizations()` exposes `locale`/`resource`.
`enUS` is the only English dictionary: `enUS.ts` holds the base strings and the component copy in
`componentStrings.ts`, both merged into one lookup table. Partial locales fall back per key.
`TranslationKey` is the union of dot paths in that dictionary; the prebuilt components type their
translate function with it, so a missing key is a compile error.

```ts
import { isTranslationKey, type TranslationKey, type TranslateParams } from "@orbitid/react";
```

API error codes are localized under `unstable__errors.<code>`; `getErrorMessage(error, t)` and
`handleOrbitError(error, setFieldErrors, { t })` use them.

## Routing

`useRouter({ routing, path, startPath })` returns `{ path, basePath, routing, navigate, match }`:

* `routing="virtual"` (default) — in-memory steps, nothing touches the URL. Shared across components.
* `routing="path"` — steps below `path`: `/sign-in/factor-one` → `path === "/factor-one"`.
* `routing="hash"` — steps in `location.hash`: `#/factor-one`.
* `match("/verify/:id")` supports `:param` segments and a trailing `*`.

`routerPush`/`routerReplace` from the provider are used when the SDK instance has no `navigate`.

## Utilities

`useLoadingStatus()` (`status`, `isLoading`, `error`, `fieldErrors`, `globalError`, `run(action)`),
`useCountdown(seconds)` (resend timers), `resolveRedirectUrl` / `isValidRedirectUrl` /
`resolveComponentUrl` / `appendRedirectParam` (redirects), `getErrorMessage` / `mapFieldErrors` /
`handleOrbitError` / `isReverificationError` (API errors), `decodeJwt`, `useRouter` / `matchPath` /
`joinPath`.

## Re-verification

```tsx
const updatePassword = useReverification((params) => user.updatePassword(params));
await updatePassword({ currentPassword, newPassword });
```

A `session_reverification_required` failure opens the verification modal registered by
`useRegisterReverificationUI()` (the prebuilt `<UserVerificationModal/>` does this), then retries
once. Cancelling rethrows unless `{ throwOnCancel: false }`. With no modal mounted, the call rejects
with an actionable error instead of silently failing.

## SSR

Pass `initialState` from the server so `useAuth()` is correct before hydration:

```tsx
<OrbitIDProvider publishableKey={pk} initialState={initialState}>{children}</OrbitIDProvider>
```

`isLoaded` is `true` as soon as `initialState` is present; `getToken()` returns `null` until
hydration (only the server can read the session cookie). Instance methods throw a descriptive error
if called before hydration.

## Required MFA and pending sessions

With `settings.mfa.required`, a sign-in or sign-up for a user without a second factor creates a
session with `status: "pending"`. The Frontend API rejects every call except `GET /me`, the
`/me/totp` routes and the `/me/phone_numbers` routes while that session is pending.

The package reports pending sessions plainly:

* `useAuth().isSignedIn` is `false` and `useAuth().sessionStatus` is `"pending"`.
* `useAuth({ treatPendingAsSignedOut: false }).isSignedIn` is `true`.
* `useSession().session?.status === "pending"`.

```tsx
const { session } = useSession();
if (session?.status === "pending") {
  // Show your own enrolment screen instead of protected content.
}
```

`<SignIn/>` and `<SignUp/>` do not report success for a pending session. They show a "Set up
two-factor authentication" step: the authenticator QR code and secret, a code input, and the ten
backup codes the server returns when verification succeeds. Phone enrolment appears when the
environment enables phone numbers as a second factor. After the server activates the session,
the component calls `setActive` and continues to the redirect target.

The same step is available on its own:

```tsx
import { SetupTwoFactor } from "@orbitid/react";

<SetupTwoFactor redirectUrl="/dashboard" />
```

Pass `sessionId` to activate a specific session, or leave it out to activate the pending session
on the SDK instance. `onComplete` replaces the redirect when the host app handles navigation.

## Tests

```bash
../../node_modules/.bin/vitest run       # jsdom, src/**/*.test.{ts,tsx}
../../node_modules/.bin/tsc -p tsconfig.json
```
