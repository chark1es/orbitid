import type { VerificationJSON } from "@orbitid/shared";

export class Verification {
  status: VerificationJSON["status"];
  strategy: string;
  attempts: number | null;
  expireAt: number | null;
  externalVerificationRedirectUrl: string | null;
  error: VerificationJSON["error"];
  nonce: string | null;

  constructor(json: VerificationJSON) {
    this.status = json.status;
    this.strategy = json.strategy;
    this.attempts = json.attempts ?? null;
    this.expireAt = json.expire_at ?? null;
    this.externalVerificationRedirectUrl = json.external_verification_redirect_url ?? null;
    this.error = json.error ?? null;
    this.nonce = json.nonce ?? null;
  }

  static fromJSON(json: VerificationJSON | null | undefined): Verification | null {
    return json ? new Verification(json) : null;
  }
}
