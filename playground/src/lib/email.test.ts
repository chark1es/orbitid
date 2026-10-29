import { describe, expect, it } from "vitest";
import {
  describeEmailTransport,
  emailFromEnvironment,
  EMAIL_TRANSPORT_LABELS,
  resolveEmailTransport,
} from "./email";

describe("resolveEmailTransport", () => {
  it("follows auto in the order Resend, SMTP, console", () => {
    expect(resolveEmailTransport({ provider: "auto", resendApiKeySet: true, smtpUrlSet: true })).toEqual({
      provider: "resend",
      automatic: true,
      missing: null,
    });
    expect(resolveEmailTransport({ provider: "auto", resendApiKeySet: false, smtpUrlSet: true })).toEqual({
      provider: "smtp",
      automatic: true,
      missing: null,
    });
    expect(resolveEmailTransport({ provider: "auto" })).toEqual({
      provider: "console",
      automatic: true,
      missing: null,
    });
  });

  it("keeps an explicit provider even when the credential it needs is missing", () => {
    expect(resolveEmailTransport({ provider: "resend", smtpUrlSet: true })).toEqual({
      provider: "resend",
      automatic: false,
      missing: "resendApiKey",
    });
    expect(resolveEmailTransport({ provider: "smtp" })).toEqual({
      provider: "smtp",
      automatic: false,
      missing: "smtpUrl",
    });
    expect(resolveEmailTransport({ provider: "console", resendApiKeySet: true })).toEqual({
      provider: "console",
      automatic: false,
      missing: null,
    });
  });

  it("treats an absent provider setting as auto", () => {
    expect(resolveEmailTransport({ smtpUrlSet: true }).provider).toBe("smtp");
  });
});

describe("describeEmailTransport", () => {
  it("names the missing credential instead of the provider", () => {
    const detail = describeEmailTransport(resolveEmailTransport({ provider: "smtp" }));
    expect(detail).toContain("Sending fails until an SMTP URL");
  });

  it("warns that the console writes codes to the server log", () => {
    const detail = describeEmailTransport(resolveEmailTransport({ provider: "console" }));
    expect(detail).toContain("printed to the server log");
  });

  it("labels every transport with a word, not only a colour", () => {
    expect(EMAIL_TRANSPORT_LABELS).toEqual({
      resend: "Resend",
      smtp: "SMTP",
      console: "Print to server log",
    });
  });
});

describe("emailFromEnvironment", () => {
  it("reads a transport the public environment might expose", () => {
    expect(emailFromEnvironment({ email: { provider: "smtp" } })).toEqual({ provider: "smtp" });
    expect(emailFromEnvironment({ email_provider: "resend" })).toEqual({ provider: "resend" });
  });

  it("ignores a value that is not a transport name", () => {
    expect(emailFromEnvironment({ email: { provider: "carrier-pigeon" } })).toBeNull();
    expect(emailFromEnvironment({ display_config: {} })).toBeNull();
    expect(emailFromEnvironment(null)).toBeNull();
  });

  it("never returns a credential", () => {
    const parsed = emailFromEnvironment({ email: { provider: "resend", resendApiKey: "re_secret" } });
    expect(parsed).toEqual({ provider: "resend" });
    expect(JSON.stringify(parsed)).not.toContain("re_secret");
  });
});
