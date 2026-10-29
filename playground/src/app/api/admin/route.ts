import { NextResponse } from "next/server";
import { auth } from "@orbitid/nextjs/server";

export const dynamic = "force-dynamic";

const REQUIRED_PERMISSION = "org:sys_memberships:manage";
const HEADERS = { "Cache-Control": "no-store", "x-demo-requires": REQUIRED_PERMISSION };

export async function GET() {
  const session = await auth();
  if (!session.isAuthenticated) {
    return NextResponse.json(
      {
        endpoint: "admin",
        error: "unauthorized",
        detail: "No session. Sign in, then send the session JWT as a bearer token.",
      },
      { status: 401, headers: HEADERS },
    );
  }

  if (!session.has({ permission: REQUIRED_PERMISSION })) {
    return NextResponse.json(
      {
        endpoint: "admin",
        error: "forbidden",
        requiredPermission: REQUIRED_PERMISSION,
        orgId: session.orgId,
        orgRole: session.orgRole,
        orgPermissions: session.orgPermissions,
        detail: "The session is valid but its active organization membership does not carry the permission.",
      },
      { status: 403, headers: HEADERS },
    );
  }

  return NextResponse.json(
    {
      endpoint: "admin",
      allowed: true,
      requiredPermission: REQUIRED_PERMISSION,
      userId: session.userId,
      orgId: session.orgId,
      orgRole: session.orgRole,
    },
    { headers: HEADERS },
  );
}
