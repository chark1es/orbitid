import { NextResponse } from "next/server";
import { auth } from "@orbitid/nextjs/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json({
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole,
    orgSlug: session.orgSlug,
    orgPermissions: session.orgPermissions,
    sessionStatus: session.sessionStatus,
    sessionClaims: session.sessionClaims,
  });
}
