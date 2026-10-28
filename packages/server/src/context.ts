import type Database from "better-sqlite3";
import type { InstanceSettings } from "@orbitid/shared";
import type { Db } from "./db";
import type { Env } from "./env";

export interface SettingsStore {
  /** Synchronous, in-memory cached; always parsed through instanceSettingsSchema. */
  get(): InstanceSettings;
  /** Deep-merges `patch`, validates, persists to `instance` table, refreshes cache. */
  update(patch: DeepPartial<InstanceSettings>): Promise<InstanceSettings>;
}
export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

export interface AppContext {
  db: Db;
  raw: Database.Database;
  env: Env;
  settings: SettingsStore;
  /** Publishable key derived from env.baseUrl. */
  publishableKey: string;
}
