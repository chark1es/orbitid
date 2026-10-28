import { createOrbitId } from "@orbitid/node";

/**
 * One SDK instance per process. `createOrbitId()` reads `ORBITID_SECRET_KEY` and `ORBITID_API_URL`
 * from the environment; keep the result on a module so every request reuses the same JWKS cache.
 */
export const orbit = createOrbitId({
  webhookSecret: process.env.ORBITID_WEBHOOK_SECRET,
});

/** Signed-in visitors may read their own profile; admins may list every user. */
export const PERMISSION_LIST_USERS = "org:sys_memberships:manage";
