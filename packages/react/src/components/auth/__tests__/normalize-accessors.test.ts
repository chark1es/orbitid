import { describe, expect, it } from "vitest";
import { normalizeSignIn, normalizeSignUp } from "../_shared/normalize";

/** Mirrors the real SDK resources, which expose verification data through getter-only accessors on the prototype. */
class AccessorSignUp {
  id = "sua_1";
  status = "missing_requirements";
  private readonly _verifications = { emailAddress: { status: "unverified", strategy: "email_code" } };
  get verifications() {
    return this._verifications;
  }
  create() {
    return Promise.resolve(this);
  }
}

class AccessorSignIn {
  id = "sia_1";
  status = "needs_first_factor";
  get supportedFirstFactors() {
    return [{ strategy: "password" }];
  }
  get firstFactorVerification() {
    return { status: "unverified", strategy: "password" };
  }
}

describe("normalize with accessor-based SDK resources", () => {
  it("normalizeSignUp shadows getter-only properties instead of throwing", () => {
    const view = normalizeSignUp(new AccessorSignUp());
    expect(view?.id).toBe("sua_1");
    expect(view?.verifications?.email_address?.strategy).toBe("email_code");
  });

  it("normalizeSignIn shadows getter-only properties instead of throwing", () => {
    const view = normalizeSignIn(new AccessorSignIn());
    expect(view?.supported_first_factors?.[0]?.strategy).toBe("password");
    expect(view?.first_factor_verification?.strategy).toBe("password");
  });
});
