import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { createRouteMatcher, orbitIdMiddleware } from "@orbitid/nextjs/server";

const isProtectedRoute = createRouteMatcher([
  "/account(.*)",
  "/organizations(.*)",
  "/api-keys(.*)",
  "/inspector(.*)",
]);

const orbitId = orbitIdMiddleware(
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

/** Loopback hosts only: the playground holds a secret key and exposes Backend API helpers, so it is a local test site. */
const isLoopbackHost = (host: string | null): boolean => {
  const name = (host ?? "").replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]" || name.endsWith(".localhost");
};

export default async function middleware(req: NextRequest, event: NextFetchEvent) {
  if (process.env.ORBITID_PLAYGROUND_ALLOW_REMOTE !== "true" && !isLoopbackHost(req.headers.get("host"))) {
    return new NextResponse("The OrbitID playground is a local test site and only answers on localhost. Set ORBITID_PLAYGROUND_ALLOW_REMOTE=true to override.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return orbitId(req, event);
}

export const config = {
  matcher: ["/((?!_next|.*\\.(?:svg|png|jpe?g|gif|ico|webp|woff2?|css|js|map|txt|xml)$).*)"],
};
