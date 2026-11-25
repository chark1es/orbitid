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
| `useAuth()` | `{ isLoaded, isSignedIn, userId, sessionId, actor, orgId, orgRole, orgSlug, orgPermissions, roles, rolePermissions, sessionClaims, sessionStatus, has, getToken, signOut }` |
| `useUser()` | `{ isLoaded, isSignedIn, user }` |
| `useSession()` | `{ isLoaded, isSignedIn, session }` |
| `useSessionList()` | `{ isLoaded, sessions, setActive, signOut }` |
| `useSignIn()` / `useSignUp()` | `{ isLoaded, signIn \| signUp, setActive }` |
| `useOrganization(params)` | `{ isLoaded, organization, membership, memberships, invitations, domains, membershipRequests, apiKeys }` |
| `useOrganizationsEnabled()` | `boolean`: whether the instance has organizations on. The prebuilt organization components lock themselves (the switcher hides) while it is `false`; use it to hide your own links. |
| `useOrganizationList(params)` | `{ isLoaded, userMemberships, userInvitations, userSuggestions, setActive, createOrganization }` |
| `useReverification(fetcher)` | wrapped fetcher that handles `session_reverification_required` |
| `useOrbitIDStatus()` | `{ isLoaded, isSignedIn, status: "loading" \| "signed-in" \| "signed-out" }` |
| `useAppearance()` / `useElementProps()` / `useElementClasses(name)` | merged appearance; `ep(key, ...classes)` element props; per-element class helper |
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

The full guide, with every variable and element key, is [docs/APPEARANCE.md](../../docs/APPEARANCE.md).

```tsx
import { OrbitIDProvider, SignIn, dark, soft } from "@orbitid/react";

<OrbitIDProvider
  appearance={{
    baseTheme: soft,
    variables: { colorPrimary: "#4f46e5", borderRadius: "0.75rem", fontFamily: "Inter, sans-serif" },
    layout: { socialButtonsVariant: "iconButton", logoPlacement: "inside" },
    elements: { cardBox: "shadow-none", formButtonPrimary: { className: "rounded-full", style: { letterSpacing: "0.02em" } } },
  }}
>
  <SignIn appearance={{ baseTheme: dark }} />
</OrbitIDProvider>
```

* Layers, lowest first: the stylesheet, instance branding, the provider's `appearance` (its `baseTheme` entries,
  then its own values), then each component's `appearance` the same way. Variables and layout replace key by key;
  element classes and styles accumulate, later layers winning conflicts.
* Themes: `defaultTheme`, `light`, `dark`, `soft`, `contrast`, `flat`. Arrays merge in order.
* Variables (`colorPrimary`, `colorBackground`, `colorForeground`, `colorMuted`, `colorDanger`, `colorInput`,
  `borderRadius`, `fontFamily`, `fontSize`, `spacingUnit`, `shadowStrength`, …) set the shadcn custom properties on
  the component root only. Unknown tokens become `--orbitid-<kebab-key>`.
* Elements: primitive keys (`button`, `buttonPrimary`, `input`, `card`, `table`, `modalContent`, …) apply to every
  component; component keys (`formButtonPrimary`, `headerTitle`, `socialButtonsIconButton`, …) to one part. Each
  takes a class string, `{ className, style, unstyled }`, a function or a list, and every element carries a stable
  `orbitid-<key>` class for plain CSS.
* `unstyled: true` drops every OrbitID class so Tailwind or your own CSS owns the look.
* Light and dark: the sign-in, sign-up, waitlist, user button, user profile and organization components pick a
  scheme in this order: a `light`/`dark` base theme in `appearance`; the instance's branding theme when it is light
  or dark; otherwise the scheme your page marks on `<html>` (a `dark`/`light` class, `data-theme="dark|light"` or an
  inline `color-scheme`, as `@orbitid/ui`'s `ThemeProvider`, next-themes and most Tailwind setups do), and only when
  the page marks none, `prefers-color-scheme`. They follow the page live when it switches, and menus and dialogs
  they portal to `<body>` carry the same scheme and variables. To tie everything to your app's own toggle, pass
  `appearance={{ baseTheme: isDark ? dark : light }}`.
* The provider renders `<div className="orbitid-root …">` carrying the CSS variables; `rootBox` classes are applied
  to that wrapper and to each component's root.
* For your own parts inside a component, `useElementProps()` returns `ep(key, ...classes)`, which applies the
  appearance for that key.

## Localization

```tsx
import { enUS, de, type LocalizationResource } from "@orbitid/react";

<OrbitIDProvider localization={de} … />
```

`t(path, vars)` interpolates `{{placeholders}}` (unknown placeholders stay visible), resolves
active locale → `enUS` → the dot-path, and `useLocalizations()` exposes `locale`/`resource`.
`enUS` is the English dictionary entry point. It composes the base strings and component-copy section modules
under `localization/` into one lookup table. Partial locales fall back per key.
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

Instance roles (`app:...`) work without an organization. `useAuth()` exposes `roles` and `rolePermissions` from the session token, and `has({ role: "app:support" })` or `has({ permission: "app:reports:read" })` checks those grants. Organization checks (`org:...`) use the active membership separately. These browser checks control UI visibility; enforce authorization on the server using verified tokens. Assign roles through the operator Backend API, never through profile metadata.
