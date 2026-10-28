// Child process for the database-transfer tests: inserts a large batch of rows straight into the database
// named by ORBITID_DATABASE_URL, so the export's keyset paging can be tested against any dialect.
import { createContext } from "../../src/bootstrap";
import * as s from "../../src/db/schema";

const url = process.env.ORBITID_DATABASE_URL;
const count = Number(process.env.TRANSFER_BULK_COUNT ?? "1200");
if (!url) throw new Error("ORBITID_DATABASE_URL is not set");

const ctx = await createContext({ databaseUrl: url, nodeEnv: "test", baseUrl: "http://localhost:4000" });
try {
  const now = Date.now();
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `user_bulk_${String(index).padStart(5, "0")}`,
    createdAt: now + index,
    updatedAt: now + index,
    publicMetadata: { index, nested: { even: index % 2 === 0 } },
    failedAttempts: 0,
    hasImage: false,
    totpVerified: false,
    isAnonymous: false,
    deleteSelfEnabled: true,
    createOrganizationEnabled: true,
    banned: index % 3 === 0,
  }));
  for (let offset = 0; offset < rows.length; offset += 300) await ctx.db.insert(s.users).values(rows.slice(offset, offset + 300) as never);
  process.stdout.write(`${JSON.stringify({ ok: true, inserted: rows.length })}\n`);
} finally {
  await ctx.close();
}
