import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, uniqueIndex } from "drizzle-orm/pg-core";
import { index as sIndex, integer, primaryKey as sPrimaryKey, sqliteTable, text as sText, uniqueIndex as sUniqueIndex } from "drizzle-orm/sqlite-core";

/** Postgres column builders; the schema is typed against this kit. */
export const postgresKit = {
  table: pgTable,
  text,
  /** Epoch milliseconds and counters. */
  int: (name: string) => bigint(name, { mode: "number" }),
  bool: (name: string) => boolean(name),
  json: <T>(name: string) => jsonb(name).$type<T>(),
  index,
  uniqueIndex,
  primaryKey,
};

export type Kit = typeof postgresKit;

/** SQLite builders with the same names and chain-compatible results. */
export const sqliteKit = {
  table: sqliteTable,
  text: sText,
  int: (name: string) => integer(name),
  bool: (name: string) => integer(name, { mode: "boolean" }),
  json: <T>(name: string) => sText(name, { mode: "json" }).$type<T>(),
  index: sIndex,
  uniqueIndex: sUniqueIndex,
  primaryKey: sPrimaryKey,
} as unknown as Kit;
