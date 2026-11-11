import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import { defaultInstanceSettings, instanceSettingsSchema, SESSION_NEVER_EXPIRES_AT, type InstanceSettings } from "@orbitid/shared";
import type { Db } from "./db";
import { instance, sessions } from "./db/schema";
import type { DeepPartial, SettingsStore } from "./context";
import { openSecrets, sealSecrets } from "./lib/secrets";
import { assertSettingsUsable, normalizeSettings, type DeliveryEnvironment } from "./lib/settings-policy";

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/** Deep merge that never walks into a prototype and never copies `__proto__`/`constructor`/`prototype` keys. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isObj(base) || !isObj(patch)) return (patch === undefined ? base : patch) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (PROTOTYPE_KEYS.has(k)) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out as T;
}

/**
 * Versioned settings migration. The stored tree is the operator's saved intent, so defaults cannot simply be
 * changed in code: an old release persisted the *whole* tree, including its then-defaults, and those rows would
 * otherwise keep forcing weekly session expiry and single-session mode forever.
 *
 * Version 2:
 *  - `session.lifetimeSeconds` 604800 (the old 7-day default) becomes 0 (no maximum).
 *  - `session.multiSession` false (the old default) becomes true.
 *  - `password.signOutOfOtherSessionsOnChange` true (the old default) becomes false.
 *  - `anonymous.retentionSeconds` 2592000 (the old 30-day default) becomes 0, i.e. retention is opt-in.
 *
 * An operator who *deliberately* chose one of those old values must re-set it once; any other custom value is
 * left untouched. The marker lives in the stored JSON (never in the validated settings tree).
 */
export const SETTINGS_VERSION_KEY = "__settingsVersion";
export const CURRENT_SETTINGS_VERSION = 2;
const OLD_DEFAULT_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const OLD_DEFAULT_GUEST_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export function migrateStoredSettings(raw: unknown): { settings: Record<string, unknown>; changed: boolean; lifetimeConverted: boolean } {
  const source = isObj(raw) ? raw : {};
  const version = typeof source[SETTINGS_VERSION_KEY] === "number" ? source[SETTINGS_VERSION_KEY] as number : 1;
  const { [SETTINGS_VERSION_KEY]: _ignored, ...clean } = structuredClone(source);
  if (version >= CURRENT_SETTINGS_VERSION) return { settings: clean, changed: false, lifetimeConverted: false };

  const migrated = structuredClone(clean);
  let lifetimeConverted = false;
  const session = isObj(migrated.session) ? migrated.session as Record<string, unknown> : undefined;
  if (session) {
    if (session.lifetimeSeconds === OLD_DEFAULT_LIFETIME_SECONDS) {
      session.lifetimeSeconds = 0;
      lifetimeConverted = true;
    }
    if (session.multiSession === false) session.multiSession = true;
  }
  const password = isObj(migrated.password) ? migrated.password as Record<string, unknown> : undefined;
  if (password && password.signOutOfOtherSessionsOnChange === true) password.signOutOfOtherSessionsOnChange = false;
  const anonymous = isObj(migrated.anonymous) ? migrated.anonymous as Record<string, unknown> : undefined;
  if (anonymous && anonymous.retentionSeconds === OLD_DEFAULT_GUEST_RETENTION_SECONDS) anonymous.retentionSeconds = 0;
  migrated[SETTINGS_VERSION_KEY] = CURRENT_SETTINGS_VERSION;
  return { settings: migrated, changed: true, lifetimeConverted };
}


/**
 * Settings have two forms, and keeping them apart is what makes "disabled features are locked" safe:
 *
 * - the **stored** tree is exactly what the operator saved (validated, but not rewritten). It keeps intent:
 *   turning organizations off and on again does not silently disable organization creation.
 * - the **served** tree (`settings.get()`) is the stored tree with disabled features forced off. Every request
 *   path reads the served tree, so a stored-but-inert switch can never be acted on.
 */
/**
 * Rows written while the old 7-day default was in force keep a concrete `expire_at`. Rewrite exactly those
 * deadlines to the unlimited sentinel so the old default cannot end a session.
 *
 * The rescue is deliberately narrow and cannot resurrect a session:
 *  - Only rows that are still **open** (`active`/`pending`) are touched. A row already marked `expired`,
 *    `revoked`, `ended`, `removed` or `replaced` stays exactly as it is: those users were already signed out
 *    (possibly deliberately, or as an MFA-enrolment guard) and flipping them back would bypass that decision.
 *  - Only a deadline equal to `created_at + 604800 s` (within a small tolerance) is the old default. A deadline
 *    the operator deliberately capped shorter or longer is left alone.
 *
 * The rewrite is idempotent: once `expire_at` is the sentinel it no longer matches, so a crash before the
 * settings version marker is written can safely re-run it on the next boot.
 */
async function rescueSessionsFromLegacyDefault(db: Db): Promise<void> {
  const sevenDays = OLD_DEFAULT_LIFETIME_SECONDS * 1000;
  const tolerance = 5 * 60_000;
  await db.update(sessions).set({
    expireAt: SESSION_NEVER_EXPIRES_AT,
    updatedAt: Date.now(),
  }).where(and(
    inArray(sessions.status, ["active", "pending"]),
    lt(sessions.expireAt, SESSION_NEVER_EXPIRES_AT),
    lte(sql`abs(${sessions.expireAt} - (${sessions.createdAt} + ${sevenDays}))`, tolerance),
  ));
}

export interface SettingsUpgradeHooks {
  /**
   * Test seam: runs after the session rewrite and before the settings version marker is persisted, so a test can
   * simulate a crash in that window and prove the next boot re-runs the idempotent rewrite.
   */
  afterSessionRewrite?: () => void | Promise<void>;
}

export async function createSettingsStore(
  db: Db,
  options: {
    production?: boolean;
    encryptionKey?: string;
    nodeEnv?: string;
    env?: DeliveryEnvironment;
    upgradeHooks?: SettingsUpgradeHooks;
  } = {},
): Promise<SettingsStore> {
  const encryptionKey = options.encryptionKey ?? "";
  const nodeEnv = options.nodeEnv ?? (options.production ? "production" : process.env.NODE_ENV);
  const read = (raw: unknown): { settings: InstanceSettings; changed: boolean; lifetimeConverted: boolean } => {
    const opened = encryptionKey ? openSecrets(encryptionKey, raw) : raw;
    const migrated = migrateStoredSettings(opened);
    return { settings: instanceSettingsSchema.parse(migrated.settings), changed: migrated.changed, lifetimeConverted: migrated.lifetimeConverted };
  };
  const write = (settings: InstanceSettings): Record<string, unknown> => {
    const stored = (encryptionKey ? sealSecrets(encryptionKey, settings) : settings) as unknown as Record<string, unknown>;
    return { ...stored, [SETTINGS_VERSION_KEY]: CURRENT_SETTINGS_VERSION };
  };
  /** Independent copy: `normalizeSettings` mutates, and the stored tree must not be touched. */
  const copy = (settings: InstanceSettings): InstanceSettings => structuredClone(settings);
  const served = (stored: InstanceSettings): InstanceSettings => normalizeSettings(copy(stored));
  // The policy runs on the served form: a combination the server would force off is not an error, it is inert.
  // Environment fallbacks count too: a deployment configured only through ORBITID_* variables can still save settings.
  const usable = (settings: InstanceSettings): void => assertSettingsUsable(settings, { nodeEnv, env: options.env });

  let stored: InstanceSettings;
  const row = (await db.select().from(instance).where(eq(instance.id, "default")))[0];
  if (row) {
    const loaded = read(row.settings);
    stored = loaded.settings;
    if (loaded.changed) {
      // Rewrite sessions first, then persist the version marker last. A crash in between leaves the old version
      // stored, so the next boot re-runs a rewrite that is idempotent (rewritten rows no longer match the old
      // deadline). Committing the marker first would strand sessions on the old 7-day deadline forever.
      if (loaded.lifetimeConverted) await rescueSessionsFromLegacyDefault(db);
      await options.upgradeHooks?.afterSessionRewrite?.();
      // Persist the migrated tree once. Without this every process start would re-read the legacy defaults and the
      // operator's dashboard would keep showing values the server no longer obeys.
      await db.update(instance).set({ settings: write(stored) as any, updatedAt: Date.now() }).where(eq(instance.id, "default"));
    }
  } else {
    stored = defaultInstanceSettings();
    // A new production instance must not trust localhost origins until the operator adds real ones.
    if (options.production) stored = instanceSettingsSchema.parse(deepMerge(stored, { application: { developmentMode: false, allowedOrigins: [] } }));
    await db.insert(instance).values({ id: "default", settings: write(stored) as any });
  }
  let cache = served(stored);

  return {
    get: () => cache,
    async update(patch: DeepPartial<InstanceSettings>) {
      const merged = instanceSettingsSchema.parse(deepMerge(stored, patch));
      // Validate what would actually be served: disabled features have lost their sub-switches, so an inert
      // stored flag is not an error, while a live contradiction (a required field that is disabled, an enabled
      // provider with no credentials, a first factor that cannot verify) is refused with a 422.
      const next = served(merged);
      usable(next);
      await db.update(instance).set({ settings: write(merged) as any, updatedAt: Date.now() }).where(eq(instance.id, "default"));
      stored = merged;
      cache = next;
      return cache;
    },
    async removeSocialProviders(keys: string[]) {
      const merged = structuredClone(stored);
      for (const key of keys) delete merged.social[key];
      const next = served(instanceSettingsSchema.parse(merged));
      usable(next);
      await db.update(instance).set({ settings: write(merged) as any, updatedAt: Date.now() }).where(eq(instance.id, "default"));
      stored = merged;
      cache = next;
      return cache;
    },
  };
}
