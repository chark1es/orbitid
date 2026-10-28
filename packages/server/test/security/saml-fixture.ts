import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let cached: string | null = null;

/**
 * A throwaway self-signed certificate for SAML connection fixtures. Generated with `openssl`, the same way
 * the SAML suite does it; cached so the suite pays for one key pair.
 */
export const SELF_SIGNED_CERT = (() => {
  if (cached) return cached;
  const dir = mkdtempSync(join(tmpdir(), "orbitid-cert-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", "/CN=security-fixture",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "pipe" });
  cached = readFileSync(join(dir, "cert.pem"), "utf8");
  return cached;
})();
