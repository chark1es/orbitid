import { notFound } from "next/navigation";
import { auth } from "@orbitid/nextjs/server";

export const dynamic = "force-dynamic";

const REQUIRED_PERMISSION = "org:sys_memberships:manage";

export default async function AdminPage() {
  const session = await auth();
  if (!session.has({ permission: REQUIRED_PERMISSION })) notFound();

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">Admin</h1>
      <p className="text-sm text-muted-foreground">
        Protected by <code>auth.protect({`{ permission: "${REQUIRED_PERMISSION}" }`})</code> in the
        middleware, then re-checked in the page.
      </p>
      <dl className="space-y-1 text-sm">
        <div className="flex gap-3">
          <dt className="text-muted-foreground">userId</dt>
          <dd className="font-mono">{session.userId}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-muted-foreground">orgId</dt>
          <dd className="font-mono">{session.orgId ?? "—"}</dd>
        </div>
        <div className="flex gap-3">
          <dt className="text-muted-foreground">permissions</dt>
          <dd className="font-mono">{session.orgPermissions?.join(", ") ?? "—"}</dd>
        </div>
      </dl>
    </div>
  );
}
