import { createRouteMatcher, orbitIdMiddleware } from "@orbitid/nextjs/server";

const isProtectedRoute = createRouteMatcher(["/dashboard(.*)", "/user(.*)", "/api/me"]);
const isAdminRoute = createRouteMatcher(["/admin(.*)"]);

export default orbitIdMiddleware(
  async (auth, req) => {
    if (isAdminRoute(req)) {
      await auth.protect({
        permission: "org:sys_memberships:manage",
        unauthorizedUrl: "/dashboard",
      });
    }
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
  },
  { signInUrl: "/sign-in", signUpUrl: "/sign-up" },
);

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"],
};
