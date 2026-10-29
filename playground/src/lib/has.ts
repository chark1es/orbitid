import type { HasParams } from "@orbitid/react";

export type HasProbeKind = "role" | "permission";

export type HasProbeResult =
  | { ok: true; params: HasParams; expression: string }
  | { ok: false; error: string };

/**
 * `has()` takes exactly one of `role` and `permission`. The tester needs the same rule so a
 * blank field cannot silently produce `has({})`, which is always false.
 */
export function buildHasProbe(kind: HasProbeKind, rawValue: string): HasProbeResult {
  const value = rawValue.trim();
  if (!value) {
    return {
      ok: false,
      error: kind === "role" ? "Enter a role, for example org:admin." : "Enter a permission, for example org:sys_memberships:manage.",
    };
  }
  if (/\s/.test(value)) {
    return { ok: false, error: "Remove the spaces. Roles and permissions have no spaces." };
  }
  const params: HasParams = kind === "role" ? { role: value } : { permission: value };
  return { ok: true, params, expression: `has({ ${kind}: "${value}" })` };
}

export function describeHasResult(allowed: boolean): { word: "Allowed" | "Denied"; detail: string } {
  return allowed
    ? { word: "Allowed", detail: "This session carries the role or permission you entered." }
    : { word: "Denied", detail: "This session does not carry the role or permission you entered." };
}
