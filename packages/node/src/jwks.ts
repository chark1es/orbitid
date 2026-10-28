import { importJWK, type JWK, type KeyLike } from "jose";
import { z } from "zod";
import { OrbitIdError } from "./errors";

const jwkSchema = z
  .object({
    kid: z.string().min(1).optional(),
    kty: z.string().min(1),
    /** Key type used for import; derived from `kty` when missing. */
    alg: z.string().min(1).optional(),
    use: z.string().optional(),
    n: z.string().optional(),
    e: z.string().optional(),
    crv: z.string().optional(),
    x: z.string().optional(),
    y: z.string().optional(),
  })
  .passthrough();

const jwksSchema = z.object({ keys: z.array(jwkSchema).max(64) }).passthrough();

export type PublicKey = KeyLike | Uint8Array;

export interface JwksCacheOptions {
  url: string;
  /** Transport used to fetch the document (already carries retry, timeout and `User-Agent`). */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Re-fetch a cached document after this long. Defaults to 10 minutes. */
  maxAgeMs?: number;
  /** Minimum gap between re-fetches triggered by an unknown `kid`. Defaults to 30 seconds. */
  cooldownMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

function algorithmFor(jwk: z.infer<typeof jwkSchema>): string {
  if (jwk.alg) return jwk.alg;
  if (jwk.kty === "RSA") return "RS256";
  if (jwk.kty === "EC") return jwk.crv === "P-384" ? "ES384" : jwk.crv === "P-521" ? "ES512" : "ES256";
  if (jwk.kty === "OKP") return "EdDSA";
  throw new OrbitIdError({ code: "jwks_invalid", reason: "jwks-fetch-failed", message: "The instance JWKS contains an unsupported key type" });
}

/**
 * Caches the instance JWKS.
 *
 * The document is re-fetched when it is older than `maxAgeMs`, and once when a token names a `kid`
 * the cache does not know (key rotation). Unknown `kid`s inside `cooldownMs` of the last such
 * refresh are answered from the cache, so a flood of tokens with made-up key ids cannot turn into a
 * flood of requests to the auth server.
 */
export class JwksCache {
  readonly url: string;
  private readonly fetchImpl: JwksCacheOptions["fetch"];
  private readonly maxAgeMs: number;
  private readonly cooldownMs: number;
  private readonly now: () => number;
  private keys = new Map<string, PublicKey>();
  private onlyKey: PublicKey | null = null;
  private fetchedAt = 0;
  private lastUnknownKidRefreshAt = 0;
  private lastFailureAt = 0;
  private lastFailure: OrbitIdError | null = null;
  private pending: Promise<void> | null = null;

  constructor(options: JwksCacheOptions) {
    this.url = options.url;
    this.fetchImpl = options.fetch;
    this.maxAgeMs = options.maxAgeMs ?? 600_000;
    this.cooldownMs = options.cooldownMs ?? 30_000;
    this.now = options.now ?? Date.now;
  }

  /** Number of keys currently cached (tests and diagnostics). */
  get size(): number {
    return this.keys.size;
  }

  async getKey(kid: string | undefined, alg: string): Promise<PublicKey> {
    if (!this.keys.size || this.now() - this.fetchedAt >= this.maxAgeMs) {
      try {
        await this.refresh();
      } catch (error) {
        // Stale keys still verify tokens signed before the outage; only fail when nothing is cached.
        if (!this.keys.size) throw error;
      }
    }

    const cached = this.lookup(kid, alg);
    if (cached) return cached;

    const at = this.now();
    if (at - this.lastUnknownKidRefreshAt >= this.cooldownMs) {
      this.lastUnknownKidRefreshAt = at;
      try {
        await this.refresh();
      } catch {
        // An unknown kid plus an unreachable JWKS is still "no matching key" to the caller.
      }
      const retried = this.lookup(kid, alg);
      if (retried) return retried;
    }
    throw new OrbitIdError({
      code: "jwks_no_matching_key",
      reason: "no-matching-key",
      message: "The session token was signed with an unknown key",
    });
  }

  private lookup(kid: string | undefined, alg: string): PublicKey | null {
    if (kid) return this.keys.get(kid) ?? null;
    // Tokens minted by a JWT template may omit `kid`; one key on the instance makes the choice unambiguous.
    return this.keys.size === 1 ? this.onlyKey : null;
  }

  private async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.lastFailure && this.now() - this.lastFailureAt < this.cooldownMs) {
      // Still serving stale keys after a failed refresh: only fail when nothing is cached.
      if (this.keys.size) return;
      throw this.lastFailure;
    }
    this.pending = this.load().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async load(): Promise<void> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.url, { headers: { Accept: "application/json" } });
    } catch (error) {
      throw this.fail(error instanceof OrbitIdError ? error : new OrbitIdError({
        code: "jwks_fetch_failed",
        reason: "jwks-fetch-failed",
        message: "Could not reach the instance JWKS endpoint",
        cause: error,
      }));
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw this.fail(new OrbitIdError({
        status: response.status,
        code: "jwks_fetch_failed",
        reason: "jwks-fetch-failed",
        message: `The instance JWKS endpoint returned status ${response.status}`,
      }));
    }

    let document: unknown;
    try {
      document = await response.json();
    } catch (error) {
      throw this.fail(new OrbitIdError({ code: "jwks_fetch_failed", reason: "jwks-fetch-failed", message: "The instance JWKS endpoint did not return JSON", cause: error }));
    }
    const parsed = jwksSchema.safeParse(document);
    if (!parsed.success || parsed.data.keys.length === 0) {
      throw this.fail(new OrbitIdError({ code: "jwks_fetch_failed", reason: "jwks-fetch-failed", message: "The instance JWKS endpoint returned an invalid key set" }));
    }

    const keys = new Map<string, PublicKey>();
    let only: PublicKey | null = null;
    for (const jwk of parsed.data.keys) {
      if (jwk.use && jwk.use !== "sig") continue;
      const algorithm = algorithmFor(jwk);
      let key: PublicKey;
      try {
        key = await importJWK(jwk as unknown as JWK, algorithm);
      } catch {
        continue; // A key this runtime cannot import is skipped; others may still verify the token.
      }
      if (jwk.kid) keys.set(jwk.kid, key);
      else only = key;
    }
    if (!keys.size && !only) {
      throw this.fail(new OrbitIdError({ code: "jwks_fetch_failed", reason: "jwks-fetch-failed", message: "The instance JWKS contains no usable signing keys" }));
    }

    this.keys = keys;
    this.onlyKey = keys.size === 1 ? [...keys.values()][0]! : only;
    this.fetchedAt = this.now();
    this.lastFailure = null;
  }

  private fail(error: OrbitIdError): OrbitIdError {
    this.lastFailure = error;
    this.lastFailureAt = this.now();
    return error;
  }
}
