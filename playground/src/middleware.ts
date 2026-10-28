import { createRouteMatcher, orbitIdMiddleware } from "@orbitid/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/account(.*)",
  "/organizations(.*)",
  "/api-keys(.*)",
  "/inspector(.*)",
]);

export default orbitIdMiddleware(
  async (auth, req) => {
    if (isProtectedRoute(req)) {
      await auth.protect();
    }
  },
  {
    signInUrl: process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL ?? "/sign-in",
    signUpUrl: process.env.NEXT_PUBLIC_ORBITID_SIGN_UP_URL ?? "/sign-up",
  },
);

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)"],
};
