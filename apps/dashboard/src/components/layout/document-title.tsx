import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { ROUTE_LABELS } from "./nav";

function titleFor(pathname: string): string {
  const segments = pathname.split("/").filter(Boolean);
  const [root, second] = segments;
  if (!root) return "Overview";
  if (root === "users" && second) return "User";
  if (root === "organizations" && second) return "Organization";
  return ROUTE_LABELS[root] ?? "Overview";
}

/** Page title per route: `Users · OrbitID`. */
export function DocumentTitle() {
  const { pathname } = useLocation();

  useEffect(() => {
    document.title = `${titleFor(pathname)} · OrbitID`;
  }, [pathname]);

  return null;
}
