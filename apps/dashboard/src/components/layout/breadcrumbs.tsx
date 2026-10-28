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

export function Breadcrumbs() {
  const { pathname } = useLocation();
  const segments = pathname.split("/").filter(Boolean);

  if (segments.length === 0) {
    return (
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbPage>Overview</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
    );
  }

  const crumbs: { label: string; href?: string }[] = [];
  segments.forEach((segment, index) => {
    const href = `/${segments.slice(0, index + 1).join("/")}`;
    const parent = segments[index - 1];
    const label =
      ROUTE_LABELS[segment] ??
      (parent === "settings" ? segment.replace(/-/g, " ") : isIdSegment(segment) ? segment : segment.replace(/-/g, " "));
    crumbs.push({ label, href });
  });

  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="hidden sm:inline-flex">
          <BreadcrumbLink asChild>
            <Link to="/">OrbitID</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator className="hidden sm:block" />
        {crumbs.map((crumb, index) => {
          const isLast = index === crumbs.length - 1;
          return (
            <span key={crumb.href} className="flex min-w-0 items-center gap-1.5">
              <BreadcrumbItem className={isLast ? "min-w-0" : "hidden md:inline-flex"}>
                {isLast ? (
                  <BreadcrumbPage className="max-w-[36ch] truncate capitalize">{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.href ?? "/"} className="capitalize">
                      {crumb.label}
                    </Link>
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
