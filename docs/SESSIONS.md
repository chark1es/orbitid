# Sessions and persistence

OrbitID's session model: what keeps an end user signed in, what may end a session, and how the browser SDK,
the server and the Next.js middleware cooperate so that nothing else does. The short version: **a session stays
signed in until the user signs out, an operator revokes it (or bans the user), or the user signs out every
client.**

## Guarantees

End users are signed out only by their own sign-out, an operator revoking the session (or banning the user), or
their choice to sign out every client. Nothing else ends a session:

- **No default expiry.** `session.lifetimeSeconds: 0` (the default) means no maximum lifetime; sessions are
  created with the far-future sentinel `expire_at`. The sentinel means "never" (unless the operator opts into a
  positive instance-wide lifetime), while **any other stored `expire_at` is an explicit per-session cap and is
  enforced** — for example a `maxLifetimeSeconds` passed when the session was created. On upgrade, a versioned
  settings migration converts a stored value equal to the old 7-day default (604800) to 0, old
  `multiSession: false` to true and old `password.signOutOfOtherSessionsOnChange: true` to false, and turns the
  old 30-day guest-retention default into 0 (opt-in). It rewrites only rows that are *still open*
  (`active`/`pending`) whose deadline is exactly `created_at + 7 days`, preserving their status. Rows already
  marked `expired`, `revoked`, `ended`, `removed` or `replaced` are never flipped back: those users were already
  signed out by the old default (or deliberately), and resurrecting them could also bypass a pending-MFA guard.
  The version marker is written **after** the rewrite, and the rewrite is idempotent, so a crash in between simply
  re-runs it. Any *other* stored value is kept. An operator who deliberately chose one of those old values must
  re-set it once after upgrading. `session.inactivityTimeoutSeconds: 0` (the default) disables idle expiry. Both
  are opt-in, validated in `lib/settings-policy.ts` and labelled as limits in the dashboard. When an inactivity
  timeout is enabled, minting a session token (an SDK refresh or a handshake) counts as activity and slides it;
  a configured maximum lifetime is absolute and never slides.
- **No sign-out on transient failure.** `@orbitid/js` schedules the next refresh from the token's own `exp`,
  refreshes on `visibilitychange`/`focus`/`online` after a suspend or offline period, and retries a failed
  refresh with exponential backoff. A network error, 5xx, 429, offline browser or throttled timer keeps local
  state and cookies. Only a 401/403 from the token endpoint is treated as authoritative, and even then the SDK
  confirms it with `GET /v1/client` before clearing anything, so a proxy's stray 401 cannot sign anybody out.
- **One tab mints, the rest share.** Tabs coordinate through a `localStorage` refresh lock and
  `BroadcastChannel`; the token is written to the shared `__session` cookie once instead of once per tab.
  Each tab keeps the session it activated: a sign-in in another tab moves the server's
  `last_active_session_id`, but it does not silently switch the account in a tab that is already signed in.
  `setActive` still switches deliberately.
- **Rotation and restarts keep sessions.** Signing keys live in the database and old public keys stay in the
  JWKS, so a key rotation does not invalidate outstanding tokens. `ORBITID_ENCRYPTION_KEY` must stay the same:
  at boot every stored signing key is decrypted and a mismatch aborts startup with an explicit error instead of
  generating a new key (which would invalidate every session).
- **Nothing incidental revokes sessions.** An instance-role change applies on the next token mint (≤ 60 s) and
  leaves sessions alone; a password change signs out other devices only when the user or operator asks
  (`sign_out_of_other_sessions`, off by default); email/profile changes, reverification, organization switching
  and MFA enrolment do not end sessions. Single-session mode (`session.multiSession: false`) is opt-in;
  multi-session is the default, so signing into a second account does not end the first.
- **Refreshes are not rate-limited like passwords.** `POST /v1/client/sessions/:id/tokens` allows 600 refreshes
  per client per minute and the handshake 600 per address per minute, far above any real tab count.
- **Guest retention sees activity.** A token refresh also refreshes `users.last_active_at` (at most once per
  five minutes), and retention never deletes a guest that still has a live (non-ended) session: its row is
  housekeeping, not a sign-out. `anonymous.retentionSeconds` is opt-in and defaults to `0` (keep guests).
- **OIDC grants end with their session.** Sign out, an operator revoke, a ban, sign-out-all, session removal and
  expiry revoke every OIDC/OAuth code, access token and refresh token minted from that session. `/oauth/userinfo`,
  `/oauth/introspect` and the refresh grant also check that the authorizing session is still active, so an
  ended session cannot keep an RP signed in through a token that was minted earlier. Grants with no browser
  session (device authorization, client credentials) keep their own lifecycle and are unaffected.
- **Organization loss ends organization authority, not the session.** Removing a membership, leaving an
  organization, deleting the organization or changing a role revokes that user's grants for applications whose
  tokens assert organization/group authority (the application configured `groups` or `organizations` in its
  scopes and did not set `groups_claim: none`). The browser session stays signed in and unrelated applications
  keep their grants. An access JWT that was already issued remains valid until its short, application-configured
  `exp`; the refresh token is dead immediately, so the RP cannot mint another and must re-authorize.
- **Refresh rotation is atomic.** Consuming a refresh token, checking that its family is still live and inserting
  the successor refresh + access token happen in one transaction. Family revocation takes the same lock. A
  concurrent duplicate either blocks and receives the winner's exact successor (inside the reuse-grace window) or
  fails cleanly; it can never observe a consumed token with no successor, revoke a live family, and then leave
  the winner's tokens alive inside that revoked family.
- **A pending session is not a signed-out browser.** A session waiting for required MFA enrolment handshakes to
  the same `sts: "pending"` token the token endpoint mints, and the browser SDK mints/refreshes that token on its
  normal schedule exactly like an active session's: cookies are kept, the middleware reports signed-in-incomplete,
  and apps can send the user to enrolment. It is never cleared as if the account had signed out.
- **Recovery ends the attacker's sessions.** A forgotten-password reset (as opposed to a password change while
  signed in) ends every other session, revokes every OIDC grant and trusted device, then sends the notification
  email. `password.signOutOfOtherSessionsOnReset` defaults to `true`; the recovering browser receives a fresh
  session with the new password.
- **Verifier clock skew is split.** The server, `@orbitid/nextjs` and `@orbitid/node` tolerate 60 s of skew on
  `nbf`/`iat` (a verifier whose clock is behind), but only **10 s on `exp`**. A 60 s session token therefore
  stops verifying at most ~70 s after it was minted, which is the real revocation bound; the old single 60 s
  tolerance effectively made it ~120 s. Both values are configurable (`expClockToleranceSeconds` /
  `expClockSkewInMs`). `@orbitid/backend#verifyToken` defaults to **exact** `exp` time and exact `nbf`/`iat`;
  set `expiredToleranceMs` for a deliberate expiry allowance and `notBeforeToleranceMs` for early-clock skew.
  The old `clockSkewInMs` is deprecated and now early-only (`nbf`/`iat`), never `exp`; a token issued in the
  future by more than the early tolerance is refused. None of these tolerances extend a server-side session: the
  database decides that.
- **The durable client cookie rolls forward.** `__client` carries the browser's maximum 400-day lifetime and is
  re-issued with the same value (no rotation) once it is a day old, on `GET /v1/client`, token refreshes and the
  handshake. A browser used regularly therefore never reaches the cap; only an abandoned cookie expires.

Retention is tied to that lifetime: a session-less client row is kept for the full `__client` cookie lifetime
plus a grace day, and any request that presents the cookie refreshes `updated_at`, so an idle-but-valid browser
is never swept out from under its own cookie. The hourly retention sweep also marks any `active`/`pending`
session past its `expire_at` or the inactivity timeout as `expired` (revoking its grants and writing
`session.ended`, exactly like the lazy read path), so an abandoned session cannot stay `active` forever and
escape deletion. Ended, revoked, expired and removed session rows are kept for a 90-day audit window before
deletion (`active`/`pending` rows are never swept); the sweep clears the attempt and client pointers to the
deleted session (`clients.last_active_session_id`, then `sign_ins`/`sign_ups.created_session_id`) in that lock
order and in the same transaction.

A client token that was rotated by a sign-in in another tab is not replaced silently: a request that presents
an unknown token is refused (`401 client_state_invalid`, no `Set-Cookie`) so it cannot overwrite the live
cookie; only the SDK's `GET /v1/client` bootstrap recovers, by discarding the unknown value and minting a
fresh random client token. A presented token is never adopted as a credential, because an attacker who can
plant a cookie (a sibling subdomain or plain-HTTP MITM) could otherwise pre-create the client and read or
patch the victim's in-flight sign-up.


- **Write contention never becomes an error.** Postgres serialises the writes that must be serialised with row
  locks and unique constraints; ordinary writes do not share one process-wide lock. A request that loses a race
  retries or gets a defined 409, never a 500. Multi-step invariants run in a transaction, and a nested transaction
  body joins the outer one with a `SAVEPOINT`.

## Development storage

There is no in-process or in-memory database. Point `ORBITID_DATABASE_URL` at any Postgres database, including a
disposable one. The Rust test harness creates a migrated template database once per embedded-migration hash
(`orbit_template_rs_<hash>`) and clones
it per test through `ORBITID_TEST_PG_ADMIN_URL`, then drops the clone. Nothing survives the test process.

## What can still end a session

The guarantees above are about OrbitID not ending a session incidentally. These are the honest remaining ways a
user can stop being signed in; each is either an operator choice, an explicit user action, or an infrastructure
loss outside the product's control:

- **An operator opts into a policy limit.** `session.lifetimeSeconds > 0` caps every session from its
  `created_at` (and a per-session `maxLifetimeSeconds` can cap one session), and
  `session.inactivityTimeoutSeconds > 0` signs a user out after that much idle time. Both default to `0`.
- **Single-session mode is opted in.** `session.multiSession: false` ends a client's other sessions when a new
  one starts. Multi-session is the default.
- **The browser loses its cookie.** `__client` is the durable credential. Clearing site data, a private window
  being closed, cookie eviction after a very long absence, or a browser policy that drops cookies all end the
  browser's ability to handshake a fresh token. The user signs in again; the account is unaffected.
- **The database loses recent writes.** A restore from a backup taken before a sign-in, or a failover to a node
  that has not received the latest session/grant rows, removes sessions that existed only in the lost writes.
  OrbitID cannot resurrect a row its database no longer has.
- **The signing or encryption key is lost or changed.** Session JWTs are signed with keys stored encrypted in the
  database. Rotating a key keeps old public keys in the JWKS, but changing `ORBITID_ENCRYPTION_KEY` without
  restoring the matching value makes the stored signing keys unreadable; startup refuses loudly rather than
  minting new keys, because new keys would invalidate every outstanding token. Losing the key material itself has
  the same effect: every outstanding session must be re-established.
- **An explicit password reset.** A forgotten-password recovery revokes the user's other sessions, OIDC grants and
  trusted devices (`password.signOutOfOtherSessionsOnReset`, on by default) so an attacker cannot keep access.
  A password *change* while signed in does not do this unless the user or operator asks.
- **Organization authority changes end OIDC grants, not the browser session.** The affected application must
  re-authorize; the user stays signed in to OrbitID itself (see above).

## Why the refresh loop looks the way it does

| Failure | Previous behaviour | Now |
|---|---|---|
| Network error / offline during refresh | Swallowed; next fixed interval retried, but a hard navigation could see a dead `__session` | Backoff retry (5 s → 60 s) and a refresh on `online`/`focus`/`visibilitychange`; cookies stay |
| 5xx or 429 from the token endpoint | Swallowed, no retry until the next fixed tick | Backoff retry; never a sign-out |
| Laptop suspend / background-tab timer throttling | Fixed `setInterval` fired late or not at all | Deadline recomputed from the token `exp`; a resume wake-up refreshes immediately |
| Many tabs refreshing together | Every tab minted its own token | `localStorage` refresh lock: one tab mints, `BroadcastChannel` shares the token and the shared cookie |
| Stray 401/403 from a proxy | Ignored, leaving a stale signed-in UI | Treated as a claim only: `GET /v1/client` confirms it; a real ended session is cleared, a proxy 401 is not |
| Token expired on a hard navigation | Next.js middleware bounced to sign-in | Handshake with the live `__client` cookie; only the API's `signed_out` answer clears cookies |
| Invalid/unverifiable handshake token | Cookies cleared (random sign-out) | Cookies kept; same 503 + `Retry-After` + meta-refresh retry as `transient`, bounded to 3 consecutive answers, then a terminal 503 with a manual "Try again" link (never a sign-out) |
| Handshake `transient` (database/signing-key failure) | Clean navigation became signed-out, then a sign-in redirect | Explicit `unavailable`: document gets 503 + `Retry-After` and a 3 s meta-refresh page, fetch gets 503 JSON; cookies are untouched and the handshake is retried; after 3 the retry is manual |
| Pending-MFA session on a hard navigation | `signed_out`, cookies cleared, enrolment broken | A pending token is minted (`sts: "pending"`); signed-in-incomplete, never signed out |
| 400-day cookie cap | `__session` was a browser-session cookie | `__session`, `__client` and `__client_uat` all use the browser maximum; `__client` is re-issued with the same value every 24 h of use |
| `expire_at` from the old 7-day default | Logged out after 7 days | A versioned settings migration converts the stored old default and rewrites deadlines on still-open rows only; rows already expired stay expired (no resurrection); a deliberately chosen value is kept |
| Inactivity timeout measured from `touch` only | Active users were signed out | Token refreshes and handshakes slide an opt-in inactivity timeout |
| Second account in the same browser | Ended the first session (single-session default) | Multi-session default; single-session is opt-in |
| Instance role change | Revoked every session | Applies on the next token mint (≤ 60 s); sessions stay |
| Password change | Signed out other devices by default | Opt-in checkbox / `sign_out_of_other_sessions: true` |
| Forgotten-password recovery | An unlimited attacker session survived the reset | Other sessions, OIDC grants and trusted devices are revoked first; the recovering browser stays signed in |
| Replayed refresh token | Kept rotating and extending its own grace window | Grace is measured from the original consumption; retries return the same successor, and nothing extends it |
| Ended session with an OIDC refresh token | RP stayed signed in | Every session end revokes the linked grants; refresh/userinfo/introspection also check the session |
| Active guest deleted by `anonymous.retentionSeconds` | Token refreshes did not update `users.last_active_at` | Refresh refreshes user activity (throttled), so only genuinely idle guests are removed |
| Changed `ORBITID_ENCRYPTION_KEY` | 500 on the first token mint (perceived sign-out) | Startup fails loudly; no signing key is regenerated |
| Stale `__client` token in a second tab | Created a fresh client and overwrote the live cookie | Refused with `401 client_state_invalid` and no `Set-Cookie`; the SDK bootstrap recovers with a newly minted random token (the stale value is never adopted) |

