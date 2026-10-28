/** First row of a query result, or undefined when the query matched nothing. */
export const first = <T>(rows: readonly T[]): T | undefined => rows[0];

import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";

/** `%` and `_` in user input must match themselves, not act as wildcards. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Case-insensitive "contains" that behaves the same on Postgres and SQLite (SQLite's LIKE already ignores ASCII case, Postgres's does not). */
export const containsText = (column: AnyColumn | SQL, text: string): SQL =>
  sql`lower(${column}) like ${`%${escapeLike(text.toLowerCase())}%`} escape '\\'`;

/** Case-insensitive "starts with". */
export const startsWithText = (column: AnyColumn | SQL, text: string): SQL =>
  sql`lower(${column}) like ${`${escapeLike(text.toLowerCase())}%`} escape '\\'`;
