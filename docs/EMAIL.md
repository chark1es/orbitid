# Email delivery

OrbitID sends every transactional email — sign-in codes, magic links, sign-up verification, invitations, password
changed and new sign-in notices — through one service, `packages/server/src/services/mail.ts`. There are two
transports: Resend (HTTP API) and SMTP (any mail server).

There is deliberately no console or file transport. A sign-in code or magic link is a credential: printed to stdout
it lands in terminal scrollback, CI logs and support pastes, and written to a file on the server it is the same secret
with a longer half-life. So when no provider is configured the server **fails closed**: the message is not delivered
(and not persisted), delivery returns a typed failure, and the startup banner says email is not configured.
Authentication can only complete when its required factors succeed; password, passkey and TOTP flows that do not
require email delivery remain available.

## Choosing a transport

`settings.email.provider` decides:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Resend when an API key exists, else SMTP when a URL exists, else nothing. |
| `resend` | Always Resend. A save without an API key is refused. |
| `smtp` | Always SMTP. A save without a URL is refused. |
| `console` | **No delivery.** Kept as the persisted "not configured" value for compatibility; the server refuses it at send time and in production refuses to enable an email flow with it. |

Settings are saved with `PATCH /v1/instance` (secret key) and live in the `email` object:

```json
{
  "email": {
    "provider": "resend",
    "resendApiKey": "re_...",
    "smtpUrl": "",
    "from": "OrbitID <no-reply@auth.example.com>"
  }
}
```

PATCH only changes the fields you send, and an empty string clears a value. Settings are validated before they are
stored: a `smtpUrl` that is not a `smtp://`/`smtps://` URL, a `from` value without an address, or any value containing a
line break is rejected with a `422` naming the offending field.

## Resend

1. Create an API key in the Resend dashboard and verify the domain you will send from.
2. Set the key and `from` address:

   ```
   ORBITID_RESEND_API_KEY=re_xxxxxxxx
   ORBITID_EMAIL_FROM="OrbitID <no-reply@auth.example.com>"
   ```

   or store the same values in the dashboard's Email settings page. The API key is stored with the other instance
   settings; environment variables only fill in fields that are still empty.

The transport calls `https://api.resend.com/emails` directly over HTTPS with a Bearer token, a 10 second timeout and a
JSON body of `{ from, to, subject, html, text }`. The host is fixed and cannot be pointed elsewhere by a setting.

## SMTP

Set `email.smtpUrl` (or `ORBITID_SMTP_URL`) to a standard URL:

```
smtp://user:password@mail.example.com:587      # STARTTLS on port 587 (or 25)
smtps://user:password@mail.example.com:465     # implicit TLS on port 465
smtp://mail.example.com:25                     # no credentials, server-to-server
```

Only `smtp://` and `smtps://` are accepted; anything else is rejected with a 422 when the settings are saved. The URL
is validated again before connecting. Connections use a 10 second connection and greeting timeout and a 20 second
socket timeout. TLS certificates are always verified (TLS 1.2 minimum) and there is no setting to disable verification,
so use a server with a valid certificate — for an internal CA, install it in the system trust store. On `smtp://`
connections STARTTLS is used whenever the server offers it, and it is required when the URL carries credentials, so a
password is never sent over a stripped connection.

Credentials are percent-encoded in the URL: `p@ss word` becomes `p%40ss%20word`.

## The From address

`email.from` (or `ORBITID_EMAIL_FROM`) accepts either a bare address or `Display Name <address>`:

```
no-reply@auth.example.com
OrbitID <no-reply@auth.example.com>
```

It must contain an address and may not contain line breaks. Display names are re-quoted when the message is built, so
a name can never add headers. Use a mailbox on a domain you control and that your provider has verified; the default
`OrbitID <no-reply@localhost>` is a placeholder that most providers will reject.

## SPF, DKIM and DMARC

Publish the SPF and DKIM records your provider shows in its dashboard, and a DMARC record for the sending domain, so
receivers accept your mail instead of quarantining it. Verify both with a DNS check (for example by sending to a
mail-tester address) before inviting real users.

## Testing delivery

`POST /v1/instance/email_test` (secret key) sends one real message through the resolved transport:

```bash
curl -X POST https://auth.example.com/v1/instance/email_test \
  -H "Authorization: Bearer sk_live_..." \
  -H "Content-Type: application/json" \
  -d '{"to":"you@example.com"}'
```
Success returns which transport was used:

```json
{ "provider": "resend", "ok": true }
```

If delivery fails the endpoint answers `502` with `{"errors":[{"code":"email_delivery_failed","message":"…"}]}`. The
message names the HTTP status and up to 300 characters of the provider's reply, with the API key redacted, so it is
safe to paste into a bug report. A malformed `to` address is a `422`. The endpoint is rate limited (10 per minute per
client address, 60 per minute overall).

The older `POST /v1/instance/test_email` still exists for compatibility: it queues a test through the normal send path
and does not report transport failures.

## Magic links open in the browser that asked for them

A magic link finishes a sign-in or sign-up only in the browser that started it. If it is opened anywhere else
(another device, a mail app's built-in browser, a stranger who was sent a link they did not ask for), the server
refuses and redirects with `__orbit_status=different_browser`. Without this, anyone could start a sign-in for somebody
else's address and have the real owner's click sign the attacker in. For sign-in across devices, use the email code.

## Without a provider

Without Resend or SMTP nothing is delivered and nothing is printed or written anywhere. This is true in development
as well: there is no "dev mode" that leaks codes. The startup banner reports `EMAIL IS NOT CONFIGURED`, and
`POST /v1/instance/email_test` answers `503 email_not_configured` with instructions. Passwords, passkeys, TOTP and
every flow that does not need a mailbox keep working.

A failed send (no provider, SMTP down, provider rejection) does not print anything either. `sendEmail` returns
`{ delivered: false, error }`; the calling auth flow still succeeds where it can, and an `email.delivery_failed` audit
entry records the template and the reason code — never the recipient, the subject, the code or the provider's
response. Use `GET /v1/audit_logs?action=email.delivery_failed` and the dashboard's email test to diagnose delivery.

In production an email-dependent flow (email code/link as a first or second factor, or verification at sign-up)
cannot be enabled without a provider: `PATCH /v1/instance` returns `422` naming `email.provider`. That is the point —
an instance that promises email sign-in and cannot send email locks every user out.

For tests, `services/mail.ts` exposes an in-memory outbox (`getMailOutbox`, `latestCodeFor`, `setMailTransport`). Those
seams throw outside `NODE_ENV=test`/`VITEST`, so a deployed server has no code path that captures a message.

## How messages are built

Templates are composed by the mail service and its extracted template helpers. Every variable that reaches the HTML is escaped, and only
absolute `http(s)` URLs are turned into links; a `javascript:` or `data:` URL is dropped. Variables are stripped of
control characters before they are used, the subject is stripped of CR/LF, and recipients must pass a strict address
check, so user-supplied names (first name, organization name, inviter name) cannot inject headers or markup.

Delivery failure records no console output. Optional notification failures do not undo an already-completed
authentication; flows requiring a delivered verification code cannot complete without it. Use the test endpoint
and recipient-free delivery audit entries to diagnose configuration failures.
