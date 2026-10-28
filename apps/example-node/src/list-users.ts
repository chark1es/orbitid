import { orbit } from "./orbit.js";

/**
 * Lists the most recent users through the Backend API.
 *
 * ```bash
 * ORBITID_SECRET_KEY=sk_test_… ORBITID_API_URL=http://localhost:4000 bun run list-users
 * ```
 */
async function main(): Promise<void> {
  const limit = Number(process.env.LIMIT ?? 20);
  const result = await orbit.client.users.getUserList({ limit, orderBy: "-created_at" });

  if (!result.data.length) {
    console.log("No users yet.");
    return;
  }

  console.log(`${result.totalCount} user${result.totalCount === 1 ? "" : "s"} (showing ${result.data.length})`);
  for (const user of result.data) {
    const email = user.emailAddresses.find((address) => address.id === user.primaryEmailAddressId)?.emailAddress ?? "—";
    const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || "—";
    console.log([user.id, email, name, new Date(user.createdAt).toISOString()].join("  "));
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
