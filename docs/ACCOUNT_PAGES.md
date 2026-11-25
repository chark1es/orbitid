# Account pages and billing links

`<UserProfile>` is each user's account page, and `<OrganizationProfile>` is each organization's settings page. Both
come from `@orbitid/react`. Each one is a set of built-in pages plus anything you add. This is also where your app's
billing UI goes: OrbitID does not process payments, but it gives billing a place on both pages and stores one
external billing-portal link per organization and per OAuth application.

OrbitID does not host end-user pages (its only built-in pages are the operator dashboard and the OAuth consent and
device screens), so mount these components on a route in your app, for example `/user-profile/*` and
`/organization/*`.

## The account page (`<UserProfile>`)

Built-in pages, in their default order:

| Id | Page | Shown when |
|---|---|---|
| `profile` | Name, photo, email addresses, phone numbers, connected accounts | always |
| `security` | Password, passkeys, authenticator app, backup codes, trusted devices, active sessions, delete account | always |
| `organizations` | The organizations the user belongs to, with their role in each (the first 50) | organizations are enabled on the instance |
| `apps` | The OAuth applications the user may sign in to, and why (instance-wide, membership, or an access grant); the first 500 by name | the user may use at least one application |
| `billing` | A **Manage billing** link for each application with a billing portal | you supply billing content, or one of the user's applications has a portal |
| `api-keys` | The user's API keys | always (loaded lazily) |

The application list uses the same rule the OAuth endpoints enforce (see [APP_ACCESS.md](APP_ACCESS.md)), so the
page never lists an application the user would be refused at sign-in.

```tsx
import { UserProfile } from "@orbitid/react";

export default function AccountPage() {
  return <UserProfile path="/user-profile" routing="path" />;
}
```

## Adding, reordering, hiding and replacing pages

`<UserProfile.Page>`, `<UserProfile.Link>`, `<OrganizationProfile.Page>` and `<OrganizationProfile.Link>` work the
same way. Each element is read in the order you write it:

- **A custom page** has a `url` (its slug) and a `label`: `<UserProfile.Page label="Team" url="team">…</UserProfile.Page>`.
- **A link** opens an external or in-app URL from the navigation: `<UserProfile.Link label="Help" url="https://…" />`.
- **A built-in page reference** has no `url`; its `label` is the built-in id (`"security"`, `"billing"`, …). It can:
  - move the page to where the element is written: `<UserProfile.Page label="security" />`
  - hide it: `<UserProfile.Page label="organizations" hidden />`
  - replace its content and keep its label and access rules: `<UserProfile.Page label="billing">…</UserProfile.Page>`

Built-in pages you do not mention stay first, in their default order. Everything you write follows, in your order.
(`<UserProfile>` groups its links below the pages, after a separator. `<OrganizationProfile>` keeps them in place.)
Fragments are fine, so pages can be added conditionally. Children that render nothing literally (`false`, `null`,
`""`, an empty fragment, so `{isAdmin && <Billing />}` when `isAdmin` is false) count as no content; a component that
returns `null` still counts as content, since that is only known once it renders. A custom page whose `url` equals a built-in id (`url="billing"`)
replaces that built-in page completely, including its access rules. To keep the built-in rules, use the reference
form without a `url`.

```tsx
import { UserProfile } from "@orbitid/react";
import { CreditCardIcon } from "lucide-react";

<UserProfile path="/user-profile" routing="path">
  {/* Your billing UI replaces the built-in Billing page. */}
  <UserProfile.Page label="billing">
    <MyBillingPanel />
  </UserProfile.Page>
  <UserProfile.Page label="Usage" url="usage" labelIcon={<CreditCardIcon className="size-4" />}>
    <MyUsagePanel />
  </UserProfile.Page>
  <UserProfile.Page label="security" />
  <UserProfile.Page label="organizations" hidden />
  <UserProfile.Link label="Help center" url="https://help.example.com" />
</UserProfile>
// Navigation: Profile, Apps (if the user has any), API keys, then Billing, Usage, Security, Help center
```

`defaultPage` picks the page shown first (`<UserProfile defaultPage="billing" />`). A page that loads later, such as
Apps or Billing, opens once it appears.

### The same page as a modal from `<UserButton>`

`<UserButton>` opens the account page in a dialog. Give it the same pages with `UserButton.UserProfilePage` and
`UserButton.UserProfileLink`, or with `userProfileProps.children`. An `Action` with `open` opens the dialog at that page:

```tsx
import { UserButton } from "@orbitid/react";

<UserButton>
  <UserButton.UserProfilePage label="billing">
    <MyBillingPanel />
  </UserButton.UserProfilePage>
  <UserButton.MenuItems>
    <UserButton.Action label="Billing" open="billing" />
  </UserButton.MenuItems>
</UserButton>
```

In `userProfileMode="navigation"`, `open="billing"` navigates to `<userProfileUrl>/billing` instead.

## The organization page (`<OrganizationProfile>`)

Built-in pages: `general`, `members`, `billing`, `api-keys`. Billing and API keys only show when they apply:

- **Billing** needs the `org:sys_billing:manage` permission (seeded on `org:admin`; see [RBAC.md](RBAC.md)) and either
  your billing content or an operator-configured billing portal for the organization. Without the permission the page
  is hidden, including content you supplied on the built-in Billing page (`<OrganizationProfile.Page label="billing">`),
  and no billing request is made. The server enforces the same permission. If the billing request fails, the Billing
  page shows an error rather than disappearing. A custom page at `url="billing"` replaces the built-in page and its
  gate, so gate that content yourself.
- **API keys** needs `org:sys_profile:manage`.

```tsx
import { OrganizationProfile, OrganizationSwitcher } from "@orbitid/react";

<OrganizationProfile>
  <OrganizationProfile.Page label="billing">
    <MyOrganizationBilling />
  </OrganizationProfile.Page>
  <OrganizationProfile.Page label="Projects" url="projects">
    <Projects />
  </OrganizationProfile.Page>
</OrganizationProfile>

// The switcher's "Manage organization" dialog takes the same pages:
<OrganizationSwitcher>
  <OrganizationSwitcher.OrganizationProfilePage label="billing">
    <MyOrganizationBilling />
  </OrganizationSwitcher.OrganizationProfilePage>
</OrganizationSwitcher>
```

## Billing portals

When you do not supply billing content, the Billing pages link to an external portal that you configure (for
example a payment provider's customer portal, or a page in your own app). Set it in the dashboard (the organization's
**Settings** tab and the OAuth application's edit sheet) or through the Backend API:

```bash
curl -X PATCH http://localhost:4000/v1/organizations/org_123 \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"billing_portal_url":"https://billing.example.com/acme"}'

curl -X PATCH http://localhost:4000/v1/oauth_applications/oa_123 \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"billing_portal_url":"https://billing.example.com/app"}'

# null (or "") clears it
curl -X PATCH http://localhost:4000/v1/organizations/org_123 \
  -H "Authorization: Bearer sk_test_..." -H "Content-Type: application/json" \
  -d '{"billing_portal_url":null}'
```

`POST /v1/organizations` and `POST /v1/oauth_applications` accept the field too. A value is stored only if it is an
absolute `https` URL of at most 2048 characters with a host, no embedded username or password, no whitespace and no
private or loopback IP literal (unless the instance allows private networks). Host names are not resolved: OrbitID never
fetches the URL, it only links to it. Anything else answers `422
form_param_format_invalid` with `meta.param_name = "billing_portal_url"`. The components also refuse to render a
non-`https` value as a link, and open portals in a new tab with `rel="noopener noreferrer"`.

Who sees which link:

| Portal | Exposed by | Visible to |
|---|---|---|
| Organization | `GET /v1/client/organizations/{id}/billing` → `{ object: "organization_billing", organization_id, portal_url }` | members with `org:sys_billing:manage`; other members get `403 org_permission_required`, non-members `404` |
| OAuth application | `billing_portal_url` on each entry of `GET /v1/client/me/oauth_applications` | every user who may use the application |

The Backend API returns `billing_portal_url` on `Organization` and `OAuthApplication`, and `organization.*` webhook
payloads carry it like the other Backend API fields. The Frontend API organization object never includes it.

## Frontend API and SDK

| Route | SDK (`@orbitid/js`) | Returns |
|---|---|---|
| `GET /v1/client/me/oauth_applications` | `user.getOAuthApplications()` | `{ response: UserOAuthApplication[] }`: `id`, `name`, `client_id`, `organization_id`, `organization` (`id`, `name`, `slug`), `access` (`instance` \| `membership` \| `grant`), `billing_portal_url`, `created_at`; sorted by name, at most 500 |
| `GET /v1/client/organizations/{id}/billing` | `organization.getBilling()` | `{ response: OrganizationBilling }` |

Both are `GET` routes that authenticate before doing anything else. A signed-out caller gets `401`. On the user
route, a session that still has to set up two-factor authentication gets `403 session_pending`. The `@orbitid/backend`
SDK takes `billingPortalUrl` on `createOrganization`, `updateOrganization`, `createOAuthApplication` and
`updateOAuthApplication`.
