import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@orbitid/ui";
import { shortId, useRegisteredBreadcrumbLabel } from "./breadcrumb-label";
import { ROUTE_LABELS, SETTINGS_LABELS } from "./nav";

function isIdSegment(segment: string): boolean {
  return segment.includes("_") || segment.length > 24 || /^[a-z]+_[A-Za-z0-9]/.test(segment);
}

function labelFor(segment: string, parent: string | undefined): string {
  // "Sessions" and "Organizations" exist twice: the Manage page and its Configure settings page. The
  // settings pages carry a qualifier so the rail shows two different words for two different pages.
  if (parent === "settings") return SETTINGS_LABELS[segment] ?? ROUTE_LABELS[segment] ?? segment.replace(/-/g, " ");
  const known = ROUTE_LABELS[segment];
  if (known) return known;
  if (isIdSegment(segment)) return segment;
  return segment.replace(/-/g, " ");
}

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage className="font-medium">Overview</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const registered = useRegisteredBreadcrumbLabel(pathname);
  const lastSegment = segments[segments.length - 1] ?? "";
  // A detail route carries an id in the URL. While its record loads the crumb shows a short id; once
  // the page registers the record's display name that name wins, also for long ids that look like slugs.
  const lastLabel = registered ?? (isIdSegment(lastSegment) ? shortId(lastSegment) : labelFor(lastSegment, segments[segments.length - 2]));

  const crumbs = segments.map((segment, index) => ({
    label: index === segments.length - 1 ? lastLabel : labelFor(segment, segments[index - 1]),
    href: `/${segments.slice(0, index + 1).join("/")}`,
  }));

  return (
    <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
      <BreadcrumbList className="min-w-0 flex-nowrap overflow-hidden text-muted-foreground">
        <BreadcrumbItem className="hidden shrink-0 lg:inline-flex">
          <BreadcrumbLink asChild>
            <Link to="/" className="text-xs">
              OrbitID
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden lg:block" />
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <span key={crumb.href} className={isLast ? "flex min-w-0 flex-1 items-center gap-1.5" : "flex shrink-0 items-center gap-1.5"}>
              <BreadcrumbItem
                className={isLast ? "block min-w-0 flex-1 truncate" : "hidden shrink-0 md:inline-flex"}
              >
                {isLast ? (
                  // `truncate` needs a block box: on an inline span it does not clip, so a long name
                  // painted over the crumb before it instead of ending in an ellipsis. No `min-w-[8ch]`:
                  // in a narrow top bar that floor is what clipped the current page title.
                  <BreadcrumbPage className="block max-w-[32ch] truncate font-medium">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.href}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast ? <BreadcrumbSeparator className="hidden md:block" /> : null}
            </span>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
