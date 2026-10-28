# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Two groups, equal weight.

- Developers who run their own OrbitID instance for a product they are building. They open the dashboard while building: to see who signed up, inspect a session, turn a sign-in method on, copy a key, check a webhook delivery.
- Operations and support staff who look after end users day to day: find a user, ban or unlock them, reset their MFA, impersonate them to reproduce a problem, invite someone to an organization.

Both are comfortable with technical terms. Neither wants to learn a vendor's vocabulary.

## Product Purpose
OrbitID is open-source authentication and user management that a developer runs on their own machine or server. The server stores everything in the developer's Postgres (SQLite is supported for small setups). The dashboard manages users, organizations, sessions and settings. SDKs for browsers, React, Next.js and backends let an application add sign-in, sign-up, profile, organization and permission features.

Success is a developer who starts the container, opens the dashboard, copies two keys into an app, and has working sign-in within minutes, with the data in a database they control.

## Positioning
The user's database, the user's server. There is no hosted service, no vendor account and no billing. Nothing phones home. The code is open source (MIT). It provides the pieces a hosted authentication product provides, but the data never leaves the operator's infrastructure.

## Operating Context
- Self-hosted: one container (or a plain `bun` process) plus Postgres. The dashboard is served by the server itself.
- The dashboard signs in with the instance secret key. There are no separate dashboard accounts yet.
- Applications talk to the server with a publishable key (browser) and a secret key (backend).
- Settings are stored as instance settings and edited in the dashboard. Environment variables cover only infrastructure (URL, database, encryption key).

## Capabilities and Constraints
- Databases: Postgres is the main backend. SQLite is supported. Both are covered by the test suite.
- Sign-in: password, email code, email link, SMS code, passkeys, social OAuth, custom OIDC, enterprise SAML and OIDC, TOTP and backup codes.
- Organizations with roles, permissions, invitations, domains and membership requests.
- Also: API keys, machine-to-machine tokens, an OIDC provider, webhooks, JWT templates, audit logs.
- Out of scope: billing and subscriptions. The product does not handle money.
- Not planned: Web3 wallets, Google One Tap, native mobile SDKs.
- Terminology to keep: user, session, organization, membership, role, permission, publishable key, secret key, instance. Avoid naming other vendors' products in the interface or in marketing copy.

## Brand Commitments
Name: OrbitID. Voice: plain and direct, engineer to engineer. Short sentences, concrete nouns, real numbers. No vendor comparisons in product copy. The icon is `assets/icon.svg`.

## Evidence on Hand
No customers, testimonials or benchmarks exist, so none may be invented. Real data comes from the running instance: user counts, sessions, enabled methods, keys. Test and preview screens use data the instance generates.

## Product Principles
1. Show what the instance actually has. Counts, methods and keys come from the running server, never from placeholders.
2. Say where the data lives. Make the database and the URL visible so an operator always knows what they are managing.
3. Do the common thing in one step. Copying a key, banning a user, enabling a method should take a click or two.
4. Dangerous actions say what they do and can be undone where possible. Impersonation, deletion and key rotation are marked as such.
5. Terms stay consistent across the dashboard, the SDKs and the docs.

## Accessibility & Inclusion
Target WCAG 2.2 AA. Keyboard-operable everywhere, visible focus, no color-only status, light and dark themes, respects reduced motion.
