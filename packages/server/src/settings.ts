import { eq } from "drizzle-orm";
import { defaultInstanceSettings, instanceSettingsSchema, type InstanceSettings } from "@orbitid/shared";
import type { Db } from "./db";
import { instance } from "./db/schema";
import type { DeepPartial, SettingsStore } from "./context";
import { openSecrets, sealSecrets } from "./lib/secrets";

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

export async function createSettingsStore(db: Db, options: { production?: boolean; encryptionKey?: string } = {}): Promise<SettingsStore> {
  const encryptionKey = options.encryptionKey ?? "";
  const read = (raw: unknown): InstanceSettings =>
    instanceSettingsSchema.parse(encryptionKey ? openSecrets(encryptionKey, raw) : raw);
  const write = (settings: InstanceSettings): Record<string, unknown> =>
    (encryptionKey ? sealSecrets(encryptionKey, settings) : settings) as unknown as Record<string, unknown>;

  let cache: InstanceSettings;
  const row = (await db.select().from(instance).where(eq(instance.id, "default")))[0];
  if (row) cache = read(row.settings);
  else {
    cache = defaultInstanceSettings();
    // A new production instance must not trust localhost origins until the operator adds real ones.
    if (options.production) cache = instanceSettingsSchema.parse(deepMerge(cache, { application: { developmentMode: false, allowedOrigins: [] } }));
    await db.insert(instance).values({ id: "default", settings: write(cache) as any });
  }
  return {
    get: () => cache,
    async update(patch: DeepPartial<InstanceSettings>) {
      const next = instanceSettingsSchema.parse(deepMerge(cache, patch));
      await db.update(instance).set({ settings: write(next) as any, updatedAt: Date.now() }).where(eq(instance.id, "default"));
      cache = next;
      return cache;
    },
  };
}
