import type { ReverificationConfig, ReverificationLevel } from "@orbitid/shared";

export interface ReverificationAges {
  /** Minutes since first-factor verification; -1/undefined when not performed. */
  firstFactor: number;
  /** Minutes since second-factor verification; -1/undefined when not performed. */
  secondFactor: number;
}

const PRESETS: Record<string, { firstFactor: number; secondFactor: number }> = {
  strict_mfa: { firstFactor: 10, secondFactor: 10 },
  strict: { firstFactor: 10, secondFactor: -1 },
  moderate: { firstFactor: 60, secondFactor: 60 },
  lax: { firstFactor: 1440, secondFactor: 1440 },
};

function toLevels(config: ReverificationConfig): { level: ReverificationLevel; afterMinutes: number }[] {
  if (typeof config === "string") {
    const preset = PRESETS[config];
    if (!preset) return [];
    const levels: { level: ReverificationLevel; afterMinutes: number }[] = [{ level: "first_factor", afterMinutes: preset.firstFactor }];
    if (preset.secondFactor >= 0) levels.push({ level: "second_factor", afterMinutes: preset.secondFactor });
    return levels;
  }
  if (config.level === "multi_factor") {
    return [
      { level: "first_factor", afterMinutes: config.afterMinutes },
      { level: "second_factor", afterMinutes: config.afterMinutes },
    ];
  }
  return [{ level: config.level, afterMinutes: config.afterMinutes }];
}

/** Evaluates `has({ reverification })` from the `fva` claim / `factor_verification_age`. */
export function checkReverification(ages: ReverificationAges | null | undefined, config: ReverificationConfig): boolean {
  if (!ages) return false;
  const levels = toLevels(config);
  if (!levels.length) return false;
  return levels.every(({ level, afterMinutes }) => {
    const age = level === "second_factor" ? ages.secondFactor : ages.firstFactor;
    return typeof age === "number" && age >= 0 && age <= afterMinutes;
  });
}

export interface HasCheckParams {
  role?: string | string[];
  permission?: string | string[];
  feature?: string;
  reverification?: ReverificationConfig;
}

export interface HasCheckContext {
  orgRole?: string | null;
  orgPermissions?: string[] | null;
  fva?: [number, number] | null;
}

function includesPermission(granted: string[], requested: string): boolean {
  return granted.some((permission) => {
    if (permission === requested) return true;
    if (permission.endsWith(":*")) return requested.startsWith(permission.slice(0, -1));
    if (requested.endsWith(":*")) return permission.startsWith(requested.slice(0, -1));
    return false;
  });
}

/**
 * Role/permission check shared by `session.has()`, `organizationMembership` helpers and the UI.
 * Supports system permissions (`org:sys_*`), custom `org:feature:permission`, wildcards (`org:team:*`)
 * and reverification presets.
 */
export function createHasCheck(context: HasCheckContext): (check: HasCheckParams) => boolean {
  return (check) => {
    if (check.reverification && !checkReverification(context.fva ? { firstFactor: context.fva[0], secondFactor: context.fva[1] } : null, check.reverification)) {
      return false;
    }
    if (check.role !== undefined) {
      const roles = Array.isArray(check.role) ? check.role : [check.role];
      if (!context.orgRole || !roles.includes(context.orgRole)) return false;
    }
    if (check.permission !== undefined && !check.feature) {
      const permissions = Array.isArray(check.permission) ? check.permission : [check.permission];
      const granted = context.orgPermissions ?? [];
      if (!permissions.every((permission) => includesPermission(granted, permission))) return false;
    }
    if (check.feature) {
      const feature = check.feature.startsWith("org:") ? check.feature : `org:${check.feature}`;
      const granted = context.orgPermissions ?? [];
      if (check.permission) {
        const requested = `${feature}:${check.permission}`;
        if (!includesPermission(granted, requested)) return false;
      } else if (!granted.some((permission) => permission === feature || permission.startsWith(`${feature}:`))) {
        return false;
      }
    }
    return true;
  };
}
