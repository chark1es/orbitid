# Email delivery

OrbitID sends every transactional email — sign-in codes, magic links, sign-up verification, invitations, password
changed and new sign-in notices — through one service, `packages/server/src/services/mail.ts`. There are three
transports: Resend (HTTP API), SMTP (any mail server) and the console.

## Choosing a transport

`settings.email.provider` decides:

| Value | Behaviour |
| --- | --- |
| `auto` (default) | Resend when an API key exists, else SMTP when a URL exists, else the console. |
| `resend` | Always Resend. Fails at send time if no API key is configured. |
| `smtp` | Always SMTP. Fails at send time if no URL is configured. |
| `console` | Prints the message, including any code or link, to the server log. |

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

## Console mode

Without Resend or SMTP, mail is printed to the server log. This is for local development only: anyone who can read
the log can read sign-in codes and magic links, and use them until they expire.

In production (`NODE_ENV=production`, which the Docker image sets) the console transport is **refused**: nothing is
printed, sign-in codes and links are not delivered, the startup banner says email is not configured, and the test
endpoint answers `503 email_not_configured`. Passwords and every other flow keep working. To try a production build
before you have a provider, set `ORBITID_ALLOW_CONSOLE_EMAIL=true` (scope: SERVER); the banner then warns loudly that
codes are going to the log. Remove it before real users arrive.

## How messages are built

Templates live in `renderEmail` in `services/mail.ts`. Every variable that reaches the HTML is escaped, and only
absolute `http(s)` URLs are turned into links; a `javascript:` or `data:` URL is dropped. Variables are stripped of
control characters before they are used, the subject is stripped of CR/LF, and recipients must pass a strict address
check, so user-supplied names (first name, organization name, inviter name) cannot inject headers or markup.

Delivery failures never break an authentication flow: `sendEmail` logs a line without the recipient's code and
continues. Use the test endpoint when you need to know whether delivery actually works.
