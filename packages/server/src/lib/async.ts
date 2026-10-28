/** Array helpers for async predicates. Array#filter and friends treat a returned promise as truthy. */
export async function filterAsync<T>(items: readonly T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
  const out: T[] = [];
  for (const item of items) if (await keep(item)) out.push(item);
  return out;
}

export async function findAsync<T>(items: readonly T[], match: (item: T) => Promise<boolean>): Promise<T | undefined> {
  for (const item of items) if (await match(item)) return item;
  return undefined;
}

export async function someAsync<T>(items: readonly T[], match: (item: T) => Promise<boolean>): Promise<boolean> {
  return (await findAsync(items, match)) !== undefined;
}
