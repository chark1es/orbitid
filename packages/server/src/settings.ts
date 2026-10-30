import { eq } from "drizzle-orm";
import { defaultInstanceSettings, instanceSettingsSchema, type InstanceSettings } from "@orbitid/shared";
import type { Db } from "./db";
import { instance } from "./db/schema";
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
 * Settings have two forms, and keeping them apart is what makes "disabled features are locked" safe:
 *
 * - the **stored** tree is exactly what the operator saved (validated, but not rewritten). It keeps intent:
 *   turning organizations off and on again does not silently disable organization creation.
 * - the **served** tree (`settings.get()`) is the stored tree with disabled features forced off. Every request
 *   path reads the served tree, so a stored-but-inert switch can never be acted on.
 */
export async function createSettingsStore(
  db: Db,
  options: { production?: boolean; encryptionKey?: string; nodeEnv?: string; env?: DeliveryEnvironment } = {},
): Promise<SettingsStore> {
  const encryptionKey = options.encryptionKey ?? "";
  const nodeEnv = options.nodeEnv ?? (options.production ? "production" : process.env.NODE_ENV);
  const read = (raw: unknown): InstanceSettings =>
    instanceSettingsSchema.parse(encryptionKey ? openSecrets(encryptionKey, raw) : raw);
  const write = (settings: InstanceSettings): Record<string, unknown> =>
    (encryptionKey ? sealSecrets(encryptionKey, settings) : settings) as unknown as Record<string, unknown>;
  /** Independent copy: `normalizeSettings` mutates, and the stored tree must not be touched. */
  const copy = (settings: InstanceSettings): InstanceSettings => structuredClone(settings);
  const served = (stored: InstanceSettings): InstanceSettings => normalizeSettings(copy(stored));
  // The policy runs on the served form: a combination the server would force off is not an error, it is inert.
  // Environment fallbacks count too: a deployment configured only through ORBITID_* variables can still save settings.
  const usable = (settings: InstanceSettings): void => assertSettingsUsable(settings, { nodeEnv, env: options.env });

  let stored: InstanceSettings;
  const row = (await db.select().from(instance).where(eq(instance.id, "default")))[0];
  if (row) stored = read(row.settings);
  else {
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
  };
}
