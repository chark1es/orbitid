import { NextResponse } from "next/server";
import { auth, currentUser } from "@orbitid/nextjs/server";
import type { User } from "@orbitid/backend";
import { primaryEmailOf } from "@/lib/user";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "x-demo-check": "auth() + currentUser()" };

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated) {
    return NextResponse.json(
      {
        endpoint: "whoami",
        error: "unauthorized",
        detail: "No session. Send Authorization: Bearer <session JWT> or a __session cookie.",
      },
      { status: 401, headers: HEADERS },
    );
  }

  let user: User | null = null;
  let userLookupError: string | null = null;
  try {
    user = await currentUser();
  } catch {
    userLookupError = "currentUser() reads the Backend API. Set ORBITID_SECRET_KEY in playground/.env.local.";
  }

  return NextResponse.json(
    {
      endpoint: "whoami",
      authenticated: true,
      userId: session.userId,
      sessionId: session.sessionId,
      orgId: session.orgId,
      orgRole: session.orgRole,
      orgSlug: session.orgSlug,
      orgPermissions: session.orgPermissions,
      sessionStatus: session.sessionStatus,
      user: user
        ? {
            id: user.id,
            firstName: user.firstName ?? null,
            lastName: user.lastName ?? null,
            username: user.username ?? null,
            email: primaryEmailOf(user),
            createdAt: user.createdAt ?? null,
          }
        : null,
      userLookupError,
    },
    { headers: HEADERS },
  );
}
