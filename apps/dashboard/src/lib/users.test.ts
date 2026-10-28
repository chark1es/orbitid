import { describe, expect, it } from "vitest";
import { buildCreateUserPayload, emptyCreateUserForm } from "./users";

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
