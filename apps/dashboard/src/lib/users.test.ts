import { describe, expect, it } from "vitest";
import { defaultInstanceSettings } from "@orbitid/shared";
import { buildCreateUserPayload, emptyCreateUserForm, missingRequiredFields, requiredUserFields } from "./users";

describe("buildCreateUserPayload", () => {
  it("trims identifiers and omits blank fields", () => {
    const payload = buildCreateUserPayload({
      ...emptyCreateUserForm(),
      email: "  ada@example.com ",
      phone: "",
      username: " ada ",
      password: "",
      firstName: " Ada ",
      lastName: " ",
      externalId: " ext_1 ",
    });

    expect(payload).toEqual({
      email_address: ["ada@example.com"],
      username: "ada",
      first_name: "Ada",
      external_id: "ext_1",
    });
  });

  it("parses non-empty metadata and keeps the password verbatim", () => {
    const payload = buildCreateUserPayload({
      ...emptyCreateUserForm(),
      email: "ada@example.com",
      password: " pass with spaces ",
      publicMetadata: '{"plan":"pro"}',
      privateMetadata: "  ",
      unsafeMetadata: '{"onboarded":false}',
      skipPasswordChecks: true,
    });

    expect(payload.password).toBe(" pass with spaces ");
    expect(payload.public_metadata).toEqual({ plan: "pro" });
    expect(payload.private_metadata).toBeUndefined();
    expect(payload.unsafe_metadata).toEqual({ onboarded: false });
    expect(payload.skip_password_checks).toBe(true);
  });

  it("rejects metadata that is valid JSON but not an object", () => {
    expect(() => buildCreateUserPayload({ ...emptyCreateUserForm(), publicMetadata: "[]" })).toThrow(
      "Public metadata: Expected a JSON object",
    );
    expect(() => buildCreateUserPayload({ ...emptyCreateUserForm(), unsafeMetadata: "{oops" })).toThrow(
      /Unsafe metadata: /,
    );
  });
});

describe("requiredUserFields", () => {
  it("is empty while settings are unknown, so a failed load never blocks an operator", () => {
    expect([...requiredUserFields(undefined)]).toEqual([]);
  });

  it("lists attributes that are both on and required, and leaves passwords out", () => {
    const settings = defaultInstanceSettings();
    settings.attributes.firstName.required = true;
    expect([...requiredUserFields(settings)].sort()).toEqual(["email", "firstName"]);
  });

  it("ignores a required attribute that is switched off", () => {
    const settings = defaultInstanceSettings();
    settings.attributes.phoneNumber.enabled = false;
    settings.attributes.phoneNumber.required = true;
    expect(requiredUserFields(settings).has("phone")).toBe(false);
  });
});

describe("missingRequiredFields", () => {
  const required = new Set(["email", "username"] as const);

  it("reports blank and whitespace-only values in form order", () => {
    expect(missingRequiredFields({ email: "  ", username: "" }, required)).toEqual(["email", "username"]);
  });

  it("passes when every required value is present", () => {
    expect(missingRequiredFields({ email: "ada@example.com", username: "ada" }, required)).toEqual([]);
  });

  it("does not report optional fields", () => {
    expect(missingRequiredFields({ email: "ada@example.com", username: "ada", phone: "" }, required)).toEqual([]);
  });
});
