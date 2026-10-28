import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { OrbitError } from "@orbitid/shared";
import { parseBody } from "../src/lib/http";

const schema = z.object({ a: z.string().optional() });
const app = new Hono()
  .onError((e, c) => c.json({ status: e instanceof OrbitError ? e.status : 500 }, 200))
  .post("/", async (c) => c.json(await parseBody(c, schema)));
const post = (body?: string) => app.request("/", { method: "POST", headers: { "content-type": "application/json" }, body });

describe("parseBody", () => {
  it("treats an empty JSON body as {}", async () => {
    expect(await (await post()).json()).toEqual({});
  });
  it("rejects malformed JSON with a 400", async () => {
    expect(await (await post("{oops")).json()).toEqual({ status: 400 });
  });
});
