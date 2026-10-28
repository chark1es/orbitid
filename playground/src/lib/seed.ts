import { createBackend } from "./env";
import { describeError } from "./errors";
import type { PlaygroundUser } from "./seed-types";
import { primaryEmailOf } from "./user";

export type PlaygroundUsersResult =
  | { ok: true; users: PlaygroundUser[]; scanned: number }
  | { ok: false; error: string; users: PlaygroundUser[] };

const FIRST_NAMES = [
  "Ada", "Grace", "Linus", "Barbara", "Alan", "Margaret", "Dennis", "Radia",
  "Ken", "Frances", "Guido", "Anita", "Bjarne", "Karen", "Donald", "Sophie",
  "Tim", "Evelyn", "James", "Hedy",
];

const LAST_NAMES = [
  "Lovelace", "Hopper", "Torvalds", "Liskov", "Kay", "Hamilton", "Ritchie", "Perlman",
  "Thompson", "Allen", "Rossum", "Borg", "Stroustrup", "Sparck Jones", "Knuth", "Wilson",
  "Berners-Lee", "Boyd", "Gosling", "Lamarr",
];

export function makeSeedIdentity(index: number, suffix: string): { firstName: string; lastName: string; email: string } {
  const firstName = FIRST_NAMES[index % FIRST_NAMES.length]!;
  const lastName = LAST_NAMES[(index * 3 + 1) % LAST_NAMES.length]!;
  const local = `${firstName}.${lastName}.${suffix}`.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return { firstName, lastName, email: `${local}@playground.test` };
}

/** Users this tool created, newest first. Only users carrying `public_metadata.playground` count. */
export async function loadPlaygroundUsers(): Promise<PlaygroundUsersResult> {
  try {
    const result = await createBackend().users.getUserList({ limit: 100, orderBy: "-created_at" });
    const users = result.data
      .filter((user) => user.publicMetadata?.playground === true)
      .map((user) => ({
        id: user.id,
        email: primaryEmailOf(user) ?? "No email",
        firstName: user.firstName ?? null,
        lastName: user.lastName ?? null,
        createdAt: user.createdAt ?? null,
      }));
    return { ok: true, users, scanned: Math.min(result.totalCount, 100) };
  } catch (error) {
    return { ok: false, error: describeError(error), users: [] };
  }
}
