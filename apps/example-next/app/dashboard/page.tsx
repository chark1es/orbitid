import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, currentUser } from "@orbitid/nextjs/server";
import { updateDisplayName } from "./actions";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const session = await auth();
  if (!session.isAuthenticated) redirect("/sign-in?redirect_url=/dashboard");

  const user = await currentUser();
  const record = user && typeof user === "object" ? (user as Record<string, unknown>) : null;
  const displayName = [record?.firstName, record?.lastName]
    .filter((value): value is string => typeof value === "string")
    .join(" ");
  const { privateMetadata, private_metadata, ...publicUser } = record ?? {};

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Hello {displayName || session.userId}. This page is rendered on the server with{" "}
          <code>auth()</code> and <code>currentUser()</code>.
        </p>
      </div>

      <section className="grid gap-4 md:grid-cols-2">
        <div className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            auth()
          </h2>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">userId</dt>
              <dd className="font-mono">{session.userId}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">sessionId</dt>
              <dd className="font-mono">{session.sessionId}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">orgId</dt>
              <dd className="font-mono">{session.orgId ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">orgRole</dt>
              <dd className="font-mono">{session.orgRole ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">orgSlug</dt>
              <dd className="font-mono">{session.orgSlug ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">can manage members</dt>
              <dd>{session.has({ permission: "org:sys_memberships:manage" }) ? "yes" : "no"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border p-4">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            currentUser()
          </h2>
          <pre className="max-h-64 overflow-auto rounded bg-muted p-3 text-xs">
            {JSON.stringify(publicUser, null, 2)}
          </pre>
        </div>
      </section>

      <section className="rounded-lg border p-4">
        <h2 className="mb-1 text-sm font-semibold">Server action example</h2>
        <p className="mb-4 text-sm text-muted-foreground">
          Calls <code>auth()</code> inside a <code>&quot;use server&quot;</code> action, then updates the
          user through the Backend API.
        </p>
        <form action={updateDisplayName} className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-muted-foreground">First name</span>
            <input
              name="firstName"
              required
              className="h-9 rounded-md border bg-background px-3"
              placeholder="Ada"
            />
          </label>
          <button
            type="submit"
            className="h-9 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
          >
            Save
          </button>
        </form>
      </section>

      <nav className="flex gap-4 text-sm">
        <Link href="/dashboard/org" className="underline underline-offset-4">
          Organization settings
        </Link>
        <Link href="/user" className="underline underline-offset-4">
          User profile
        </Link>
      </nav>
    </div>
  );
}
