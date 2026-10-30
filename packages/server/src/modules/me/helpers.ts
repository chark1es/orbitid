/** Closures shared by the signed-in user route groups. */
import { type Context } from "hono";
import type { AppContext } from "../../context";
import { and } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { serializeUser } from "../../serializers";
import { userHasMfa } from "../../services/mfa";
import { completeMfaEnrollment } from "../../services/sessions";
import { getUserById, type UserRow } from "../../services/users";
import { emitEvent } from "../../services/webhooks";
import { getOrCreateClient, requireActiveUser } from "../auth/client-auth";

export function createMeHelpers(ctx: AppContext) {
  // A pending session (required MFA, no factor yet) may only do what enrolling a factor takes.
  const PENDING_ALLOWED = [
    /^GET \/$/, /^GET \/totp$/, /^POST \/totp$/, /^POST \/totp\/attempt_verification$/,
    /^(GET|POST) \/phone_numbers$/, /^(GET|PATCH) \/phone_numbers\/[^/]+$/, /^POST \/phone_numbers\/[^/]+\/(prepare|attempt)_verification$/,
  ];
  const auth = async (c: Context) => {
    const client = await getOrCreateClient(ctx, c);
    const { session, user } = await requireActiveUser(ctx, client);
    if (session.status === "pending") {
      const route = `${c.req.method} ${new URL(c.req.url).pathname.replace(/^\/v1\/client\/me/, "").replace(/\/+$/, "") || "/"}`;
      if (!PENDING_ALLOWED.some((allowed) => allowed.test(route))) {
        throw new OrbitError(403, ErrorCodes.session_pending, "Finish setting up two-factor authentication before doing anything else");
      }
    }
    return { client, session, user };
  };

  /** Enrolling a factor activates the session that did it (and only that one). */
  const settleEnrollment = async (userId: string, sessionId: string) => {
    if (await userHasMfa(ctx, await reloadUser(userId))) await completeMfaEnrollment(ctx, userId, sessionId);
  };

  const userResponse = async (user: UserRow) => ({ response: await serializeUser(ctx, user) });

  const emitUserUpdated = async (userId: string) => {
    const user = await getUserById(ctx, userId);
    if (user) await emitEvent(ctx, "user.updated", await serializeUser(ctx, user, { backend: true }));
  };

  const reloadUser = async (id: string) => (await getUserById(ctx, id))!;
  return { auth, settleEnrollment, userResponse, emitUserUpdated, reloadUser };
}

export type MeHelpers = ReturnType<typeof createMeHelpers>;
