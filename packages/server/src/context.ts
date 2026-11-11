import type { InstanceSettings } from "@orbitid/shared";
import type { Db, Dialect, Driver } from "./db";
import type { Env } from "./env";

export interface SettingsStore {
  /** Synchronous, in-memory cached; always parsed through instanceSettingsSchema. */
  get(): InstanceSettings;
  /** Deep-merges `patch`, validates, persists to the `instance` table, refreshes the cache. */
  update(patch: DeepPartial<InstanceSettings>): Promise<InstanceSettings>;
  /** Removes social provider entries entirely (deep merge alone cannot delete a key). */
  removeSocialProviders(keys: string[]): Promise<InstanceSettings>;
}
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface AppContext {
  db: Db;
  /** Which database is in use, for the dashboard and health endpoint. */
  database: { driver: Driver; dialect: Dialect; label: string };
  env: Env;
  settings: SettingsStore;
  /** Publishable key derived from env.baseUrl. */
  publishableKey: string;
  close(): Promise<void>;
}
