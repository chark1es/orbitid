import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@orbitid/ui";
import { ROUTE_LABELS } from "./nav";

function isIdSegment(segment: string): boolean {
  return segment.includes("_") || segment.length > 24 || /^[a-z]+_[A-Za-z0-9]/.test(segment);
}

function labelFor(segment: string, parent: string | undefined): string {
  const known = ROUTE_LABELS[segment];
  if (known) return known;
  if (parent === "settings") return segment.replace(/-/g, " ");
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

  const crumbs = segments.map((segment, index) => ({
    label: labelFor(segment, segments[index - 1]),
    href: `/${segments.slice(0, index + 1).join("/")}`,
  }));

  return (
    <Breadcrumb className="min-w-0 flex-1 overflow-hidden">
      <BreadcrumbList className="flex-nowrap text-muted-foreground">
        <BreadcrumbItem className="hidden sm:inline-flex">
          <BreadcrumbLink asChild>
            <Link to="/" className="font-data text-xs">
              OrbitID
            </Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden sm:block" />
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <span key={crumb.href} className="flex min-w-0 items-center gap-1.5">
              <BreadcrumbItem className={isLast ? "min-w-0" : "hidden md:inline-flex"}>
                {isLast ? (
                  <BreadcrumbPage className="max-w-[32ch] truncate font-medium">{crumb.label}</BreadcrumbPage>
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
