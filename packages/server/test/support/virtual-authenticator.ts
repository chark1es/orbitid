// A software WebAuthn authenticator for tests.
//
// It produces exactly the JSON a browser hands to the server: base64url fields, `response.transports`,
// `authenticatorAttachment` and `clientExtensionResults`. Key pairs come from `node:crypto`, and the
// client data, authenticator data, attestation object (CBOR `fmt: "none"`) and assertion signatures
// are built byte for byte as the WebAuthn spec describes, so the server verifies them with its real
// `@simplewebauthn/server` code path instead of a mock.
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  AuthenticatorTransportFuture,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();

export const toBase64URL = (data: Uint8Array): string => Buffer.from(data).toString("base64url");
export const fromBase64URL = (value: string): Buffer => Buffer.from(value, "base64url");

/** Flags from the WebAuthn authenticator data bit field. */
const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

// ───────────── a tiny CBOR encoder (RFC 8949 subset: the four types WebAuthn needs) ─────────────

export type CborValue = number | string | Uint8Array | CborValue[] | Map<number | string, CborValue>;

function encodeHead(major: number, value: number): Buffer {
  const m = major << 5;
  if (value < 24) return Buffer.from([m | value]);
  if (value < 0x100) return Buffer.from([m | 24, value]);
  if (value < 0x10000) {
    const out = Buffer.alloc(3);
    out[0] = m | 25;
    out.writeUInt16BE(value, 1);
    return out;
  }
  if (value < 0x100000000) {
    const out = Buffer.alloc(5);
    out[0] = m | 26;
    out.writeUInt32BE(value, 1);
    return out;
  }
  throw new RangeError(`CBOR integer out of range: ${value}`);
}

export function cborEncode(value: CborValue): Buffer {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) throw new TypeError(`CBOR cannot encode ${value}`);
    return value >= 0 ? encodeHead(0, value) : encodeHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([encodeHead(3, bytes.length), bytes]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([encodeHead(2, value.length), value]);
  if (Array.isArray(value)) return Buffer.concat([encodeHead(4, value.length), ...value.map(cborEncode)]);
  if (value instanceof Map) {
    const parts: Buffer[] = [encodeHead(5, value.size)];
    for (const [key, item] of value) parts.push(cborEncode(key), cborEncode(item));
    return Buffer.concat(parts);
  }
  throw new TypeError(`Cannot CBOR-encode ${typeof value}`);
}

// ───────────── the authenticator ─────────────

export interface VirtualAuthenticatorOptions {
  /** COSE algorithm: ES256 (`-7`, a platform passkey) or RS256 (`-257`, a security key). */
  alg?: "ES256" | "RS256";
  /** Relying party ID the credential is scoped to (a hostname, never including the port). */
  rpID: string;
  /** Full origin the credential is scoped to, e.g. `https://app.example.com`. */
  origin: string;
  /** Whether the authenticator can verify the user (PIN/biometric). When false it returns UV=0. */
  userVerification?: boolean;
  /** Backup eligibility / backup state flags (synced multi-device creds report both). */
  backupEligible?: boolean;
  backupState?: boolean;
  /** Signature counter, start value. `0` models an authenticator that does not count. */
  counter?: number;
  transports?: AuthenticatorTransportFuture[];
  attachment?: "platform" | "cross-platform";
  /** 16-byte AAGUID; random by default so two virtual authenticators never look alike. */
  aaguid?: Uint8Array;
}

export interface CredentialOverrides {
  challenge?: string;
  origin?: string;
  rpID?: string;
  /** Present the assertion as another credential id (wrong-key / foreign-credential cases). */
  credentialId?: string;
  userHandle?: string;
  /** Force the flags instead of the authenticator's defaults. */
  userVerified?: boolean;
  userPresent?: boolean;
  /** Send this counter instead of the next one (cloned-authenticator cases). */
  counter?: number;
  backupState?: boolean;
}

interface KeyMaterial {
  alg: number;
  privateKey: KeyObject;
  cose: Uint8Array;
}

function generateKey(alg: "ES256" | "RS256"): KeyMaterial {
  if (alg === "ES256") {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x?: string; y?: string };
    if (!jwk.x || !jwk.y) throw new Error("EC key export failed");
    // COSE_Key for EC2 / P-256 / ES256: {1:2, 3:-7, -1:1, -2:x, -3:y}
    return {
      alg: -7,
      privateKey,
      cose: cborEncode(new Map<number | string, CborValue>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, fromBase64URL(jwk.x)],
        [-3, fromBase64URL(jwk.y)],
      ])),
    };
  }
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = publicKey.export({ format: "jwk" }) as { n?: string; e?: string };
  if (!jwk.n || !jwk.e) throw new Error("RSA key export failed");
  // COSE_Key for RSA / RS256: {1:3, 3:-257, -1:n, -2:e}
  return {
    alg: -257,
    privateKey,
    cose: cborEncode(new Map<number | string, CborValue>([
      [1, 3],
      [3, -257],
      [-1, fromBase64URL(jwk.n)],
      [-2, fromBase64URL(jwk.e)],
    ])),
  };
}

export class VirtualAuthenticator {
  readonly alg: "ES256" | "RS256";
  readonly rpID: string;
  readonly origin: string;
  readonly transports: AuthenticatorTransportFuture[];
  readonly attachment: "platform" | "cross-platform";
  /** base64url credential id created by `register()`. */
  credentialId = "";
  /** base64url user handle the authenticator stores with the credential (returned on assertions). */
  userHandle = "";
  counter = 0;
  private key: KeyMaterial;
  private readonly aaguid: Uint8Array;
  private readonly userVerification: boolean;
  private readonly backupEligible: boolean;
  private backupState: boolean;

  constructor(options: VirtualAuthenticatorOptions) {
    this.alg = options.alg ?? "ES256";
    this.rpID = options.rpID;
    this.origin = options.origin;
    this.userVerification = options.userVerification ?? true;
    this.backupEligible = options.backupEligible ?? true;
    this.backupState = options.backupState ?? true;
    this.counter = options.counter ?? 0;
    this.transports = options.transports ?? (this.alg === "ES256" ? ["internal", "hybrid"] : ["usb", "nfc"]);
    this.attachment = options.attachment ?? (this.alg === "ES256" ? "platform" : "cross-platform");
    this.aaguid = options.aaguid ?? randomBytes(16);
    this.key = generateKey(this.alg);
  }

  private clientData(type: "webauthn.create" | "webauthn.get", challenge: string, origin: string): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }), "utf8");
  }

  private authData(input: {
    rpID: string;
    flags: number;
    counter: number;
    attestedCredential?: { id: Buffer; cose: Uint8Array };
  }): Buffer {
    const head = Buffer.alloc(37);
    sha256(input.rpID).copy(head, 0);
    head[32] = input.flags;
    head.writeUInt32BE(input.counter, 33);
    if (!input.attestedCredential) return head;
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(input.attestedCredential.id.length, 0);
    return Buffer.concat([head, this.aaguid, idLength, input.attestedCredential.id, input.attestedCredential.cose]);
  }

  private flags(options: { userPresent?: boolean; userVerified?: boolean; backupState?: boolean } = {}): number {
    const uv = options.userVerified ?? this.userVerification;
    const bs = options.backupState ?? this.backupState;
    let flags = (options.userPresent ?? true) ? FLAG_UP : 0;
    if (uv) flags |= FLAG_UV;
    if (this.backupEligible) flags |= FLAG_BE;
    if (this.backupEligible && bs) flags |= FLAG_BS;
    return flags;
  }

  private sign(data: Buffer): Buffer {
    // WebAuthn signatures: DER-encoded ECDSA for ES256, PKCS#1 v1.5 for RS256.
    return sign("sha256", data, this.key.privateKey);
  }

  /** `navigator.credentials.create()`: attestation object with `fmt: "none"`. */
  register(options: PublicKeyCredentialCreationOptionsJSON, overrides: CredentialOverrides = {}): RegistrationResponseJSON {
    const rpID = overrides.rpID ?? options.rp.id ?? this.rpID;
    const origin = overrides.origin ?? this.origin;
    const challenge = overrides.challenge ?? options.challenge;
    const credentialId = overrides.credentialId ? fromBase64URL(overrides.credentialId) : randomBytes(32);
    const clientDataJSON = this.clientData("webauthn.create", challenge, origin);
    const authData = this.authData({
      rpID,
      flags: this.flags({ userPresent: overrides.userPresent, userVerified: overrides.userVerified, backupState: overrides.backupState }) | FLAG_AT,
      counter: 0,
      attestedCredential: { id: credentialId, cose: this.key.cose },
    });
    const attestationObject = cborEncode(new Map<number | string, CborValue>([
      ["fmt", "none"],
      ["attStmt", new Map<number | string, CborValue>()],
      ["authData", authData],
    ]));
    this.credentialId = toBase64URL(credentialId);
    this.userHandle = overrides.userHandle ?? options.user.id;
    this.counter = 0;
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: "public-key",
      authenticatorAttachment: this.attachment,
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64URL(clientDataJSON),
        attestationObject: toBase64URL(attestationObject),
        transports: [...this.transports],
        publicKeyAlgorithm: this.key.alg,
      },
    };
  }

  /** `navigator.credentials.get()`: signed assertion over `authenticatorData || SHA-256(clientDataJSON)`. */
  authenticate(options: PublicKeyCredentialRequestOptionsJSON, overrides: CredentialOverrides = {}): AuthenticationResponseJSON {
    const challenge = overrides.challenge ?? options.challenge;
    const origin = overrides.origin ?? this.origin;
    const rpID = overrides.rpID ?? options.rpId ?? this.rpID;
    const counter = overrides.counter ?? this.counter + 1;
    const clientDataJSON = this.clientData("webauthn.get", challenge, origin);
    const authData = this.authData({
      rpID,
      flags: this.flags({ userPresent: overrides.userPresent, userVerified: overrides.userVerified, backupState: overrides.backupState }),
      counter,
    });
    const signature = this.sign(Buffer.concat([authData, sha256(clientDataJSON)]));
    this.counter = counter;
    const id = overrides.credentialId ?? this.credentialId;
    const userHandle = overrides.userHandle ?? this.userHandle;
    return {
      id,
      rawId: id,
      type: "public-key",
      authenticatorAttachment: this.attachment,
      clientExtensionResults: {},
      response: {
        clientDataJSON: toBase64URL(clientDataJSON),
        authenticatorData: toBase64URL(authData),
        signature: toBase64URL(signature),
        ...(userHandle ? { userHandle } : {}),
      },
    };
  }
}
