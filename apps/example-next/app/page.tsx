export default function HomePage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight">OrbitID on Next.js</h1>
      <p className="max-w-2xl text-muted-foreground">
        App Router demo using <code>orbitIdMiddleware</code>, server-side <code>auth()</code>,{" "}
        <code>currentUser()</code>, SSR-hydrated <code>useAuth()</code>, organizations, webhooks and
        server actions.
      </p>
      <ul className="list-inside list-disc space-y-2 text-sm text-muted-foreground">
        <li>
          <code>/dashboard</code> — protected by the middleware, renders <code>auth()</code> and{" "}
          <code>currentUser()</code> on the server.
        </li>
        <li>
          <code>/admin</code> — requires the <code>org:sys_memberships:manage</code> permission.
        </li>
        <li>
          <code>/sign-in</code>, <code>/sign-up</code>, <code>/waitlist</code> — prebuilt OrbitID
          components with path routing.
        </li>
        <li>
          <code>/api/me</code> — protected route handler; <code>/api/webhooks</code> — Svix-verified
          webhook endpoint.
        </li>
      </ul>
    </div>
  );
}
