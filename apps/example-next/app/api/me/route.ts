import { NextResponse } from "next/server";
import { auth } from "@orbitid/nextjs/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Only the fields this endpoint is meant to expose. `sessionClaims` also holds custom claims and the raw
  // token metadata, which belong to the server's auth layer, not to an API response.
  return NextResponse.json({
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole,
    orgSlug: session.orgSlug,
    orgPermissions: session.orgPermissions,
    sessionStatus: session.sessionStatus,
    canManageMembers: session.has({ permission: "org:sys_memberships:manage" }),
  });
}
