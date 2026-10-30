/** User profile-image routes. */
import type { Hono } from "hono";
import type { AppContext } from "../../../context";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { parseBody } from "../../../lib/http";
import * as s from "../../../db/schema";
import { serializeUser } from "../../../serializers";
import { emitEvent } from "../../../services/webhooks";
import { audit } from "../../../services/audit";
import { getUserOrThrow } from "../shared";
import { IMAGE_CONTENT_TYPES, assertImageBytes } from "../../../lib/images";
import { AUDIT_ACTOR, MAX_PROFILE_IMAGE_BYTES } from "./shared";

export function registerImageRoutes(app: Hono, ctx: AppContext) {
  app.post("/users/:id/profile_image", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    let dataUrl: string;
    if ((c.req.header("content-type") ?? "").includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!(file instanceof File)) throw new OrbitError(422, ErrorCodes.form_param_missing, "file is required.", { param_name: "file" });
      if (file.size > MAX_PROFILE_IMAGE_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Image must be smaller than 512 KB.", { param_name: "file" });
      const bytes = Buffer.from(await file.arrayBuffer());
      const kind = assertImageBytes(bytes, "file");
      dataUrl = `data:${IMAGE_CONTENT_TYPES[kind]};base64,${bytes.toString("base64")}`;
    } else {
      const body = await parseBody(c, z.object({ file: z.string().max(MAX_PROFILE_IMAGE_BYTES) }));
      // Only an image data URL of an allowed raster format; remote URLs are not fetched by the server.
      const match = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(body.file.trim());
      if (!match) {
        throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "file must be a base64 image data URL", { param_name: "file" });
      }
      const bytes = Buffer.from(match[2]!, "base64");
      if (bytes.byteLength > MAX_PROFILE_IMAGE_BYTES) throw new OrbitError(413, ErrorCodes.form_param_format_invalid, "Image must be smaller than 512 KB.", { param_name: "file" });
      const kind = assertImageBytes(bytes, "file");
      dataUrl = `data:${IMAGE_CONTENT_TYPES[kind]};base64,${bytes.toString("base64")}`;
    }
    await ctx.db.update(s.users).set({ imageUrl: dataUrl, hasImage: true, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.profile_image.updated", targetType: "user", targetId: existing.id });
    return c.json(json);
  });

  app.delete("/users/:id/profile_image", async (c) => {
    const existing = await getUserOrThrow(ctx, c.req.param("id"));
    await ctx.db.update(s.users).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.users.id, existing.id));
    const json = await serializeUser(ctx, await getUserOrThrow(ctx, existing.id), { backend: true });
    await emitEvent(ctx, "user.updated", json);
    await audit(ctx, { actor: AUDIT_ACTOR, action: "user.profile_image.removed", targetType: "user", targetId: existing.id });
    return c.json(json);
  });
}
