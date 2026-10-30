import type { Kit } from "../kit";

export type Meta = Record<string, unknown>;

/** Column builders and the shared timestamp helpers every table group needs. */
export function tableBuilders(kit: Kit) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey } = kit;
  const ts = (name: string) => int(name).notNull().$defaultFn(() => Date.now());
  const created = () => ({ createdAt: ts("created_at"), updatedAt: ts("updated_at") });
  return { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created };
}
