// Secret handling for instance settings: masked on the wire, encrypted at rest.
//
// The dashboard's settings editor round-trips whole settings objects, so every response masks secret values
// and every write drops echoed masks instead of storing them. Values written by older versions are
// plaintext; they read as-is and are sealed with the instance encryption key on the next write.
import type { InstanceSettings } from "@orbitid/shared";
import { decrypt, encrypt } from "./crypto";

type Tree = Record<string, unknown>;

/** Wire mask for every secret field; the dashboard shows `<field>Set` next to it. */
const MASK = "••••";
/** `lib/crypto.encrypt` output: `v1.<iv>.<tag>.<ciphertext>` (base64url). */
const CIPHER_RE = /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

interface SecretSlot {
  /** Path from the settings root, so callers can look the same slot up in the stored tree. */
  path: string[];
}

const SECRET_SLOTS: SecretSlot[] = [
  { path: ["email", "smtpUrl"] },
  { path: ["email", "resendApiKey"] },
  { path: ["sms", "twilioAuthToken"] },
  { path: ["security", "captchaSecret"] },
];
const SOCIAL_SLOTS: { key: string }[] = [
  { key: "clientSecret" },
  { key: "applePrivateKey" },
];

/** Every secret location in a settings-shaped tree. Social providers are dynamic, so they are expanded here. */
function secretSlots(root: unknown): SecretSlot[] {
  const tree = (root && typeof root === "object" ? root : {}) as Tree;
  const slots = [...SECRET_SLOTS];
  const social = tree.social;
  if (social && typeof social === "object" && !Array.isArray(social)) {
    for (const provider of Object.keys(social)) {
      for (const slot of SOCIAL_SLOTS) slots.push({ path: ["social", provider, slot.key] });
    }
  }
  return slots;
}

const at = (root: unknown, path: string[]): unknown => {
  let node: unknown = root;
  for (const segment of path) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Tree)[segment];
  }
  return node;
};
const put = (root: Tree, path: string[], value: unknown) => {
  let node: Tree = root;
  for (const segment of path.slice(0, -1)) {
    const next = node[segment];
    if (!next || typeof next !== "object" || Array.isArray(next)) return;
    node = next as Tree;
  }
  node[path[path.length - 1]!] = value;
};
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const isSealedSecret = (value: unknown): value is string => typeof value === "string" && CIPHER_RE.test(value);

/** Reads a stored secret: sealed values are decrypted, plaintext (older versions) passes through. */
export function openSecret(encryptionKey: string, value: string): string {
  if (!isSealedSecret(value)) return value;
  try {
    return decrypt(encryptionKey, value);
  } catch {
    return "";
  }
}

/** Seals a plaintext secret. Already-sealed values are returned unchanged. */
export function sealSecret(encryptionKey: string, value: string): string {
  if (!value || isSealedSecret(value)) return value;
  return encrypt(encryptionKey, value);
}

/** True for a value this module produced, so a round-tripped editor cannot overwrite a secret with its mask. */
export function isMaskedSecret(value: unknown): boolean {
  return value === MASK;
}

/** Settings tree with every secret replaced by its mask, plus a `<field>Set` marker for the editor. */
export function maskSecrets(settings: InstanceSettings): Tree {
  const copy = clone(settings) as unknown as Tree;
  for (const { path } of secretSlots(copy)) {
    const value = at(copy, path);
    const owner = at(copy, path.slice(0, -1));
    if (owner && typeof owner === "object" && !Array.isArray(owner)) (owner as Tree)[`${path[path.length - 1]}Set`] = typeof value === "string" && value.length > 0;
    if (typeof value === "string" && value.length > 0) put(copy, path, MASK);
  }
  return copy;
}

/**
 * Drops `*Set` helpers and echoed secrets from a PATCH body: a masked value, or the stored plaintext sent
 * back unchanged, means "keep what is stored". Any other value is a deliberate replacement.
 */
export function unmaskSettingsPatch(current: InstanceSettings, patch: Tree): Tree {
  const slots = secretSlots(current);
  const strip = (value: unknown, path: string[]): unknown => {
    if (Array.isArray(value)) return value.map((item, index) => strip(item, [...path, String(index)]));
    if (!value || typeof value !== "object") return value;
    const out: Tree = {};
    for (const [key, item] of Object.entries(value as Tree)) {
      if (key.endsWith("Set")) continue;
      const childPath = [...path, key];
      const slot = slots.find((candidate) => candidate.path.join(".") === childPath.join("."));
      if (slot && typeof item === "string") {
        // Masked, or the stored value echoed back unchanged: keep what is stored.
        if (isMaskedSecret(item) || item === at(current, childPath)) continue;
      }
      out[key] = strip(item, childPath);
    }
    return out;
  };
  return strip(patch, []) as Tree;
}

/** Seals every plaintext secret before the tree is written to the instance table. */
export function sealSecrets(encryptionKey: string, settings: InstanceSettings): Tree {
  const copy = clone(settings) as unknown as Tree;
  for (const { path } of secretSlots(copy)) {
    const value = at(copy, path);
    if (typeof value === "string" && value) put(copy, path, sealSecret(encryptionKey, value));
  }
  return copy;
}

/** Opens every sealed secret after reading the instance table; plaintext rows from older versions pass through. */
export function openSecrets(encryptionKey: string, settings: unknown): unknown {
  const copy = clone(settings) as Tree;
  for (const { path } of secretSlots(copy)) {
    const value = at(copy, path);
    if (isSealedSecret(value)) put(copy, path, openSecret(encryptionKey, value));
  }
  return copy;
}
