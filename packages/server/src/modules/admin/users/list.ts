/** User count and list routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { count } from "drizzle-orm";
import * as s from "../../../db/schema";
import { serializeUser } from "../../../serializers";
import { listParams, page, parseOrderBy } from "../shared";
import { first } from "../../../lib/db";
import { USER_ORDER_COLUMNS, userWhere } from "./shared";

export function registerListRoutes(app: Hono, ctx: AppContext) {
  app.get("/users/count", async (c) => {
    const total = first(await ctx.db.select({ n: count() }).from(s.users).where(await userWhere(ctx, c)))?.n ?? 0;
    return c.json({ object: "total_count", total_count: Number(total) });
  });

  app.get("/users", async (c) => {
    const where = await userWhere(ctx, c);
    const { limit, offset, order_by } = listParams(c);
    const order = parseOrderBy(order_by, USER_ORDER_COLUMNS, "-created_at");
    const rows = (await ctx.db.select().from(s.users).where(where).orderBy(order).limit(limit).offset(offset));
    const total = Number(first(await ctx.db.select({ n: count() }).from(s.users).where(where))?.n ?? 0);
    const data = (await Promise.all(rows.map((row) => serializeUser(ctx, row, { backend: true }))));
    if (c.req.query("paginated") === "true") return c.json(page(data, total));
    c.header("x-total-count", String(total));
    return c.json(data);
  });
}
