import { Suspense, useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { preloadRoute } from "../../pages";
import { PageFallback } from "../../lib/lazy-page";
import {
  AppIcon,
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@orbitid/ui";
import { getApiUrl } from "../../lib/api";
import { useShowOrganizations } from "../../lib/features";
import { useInstance } from "../../lib/instance";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbLabelProvider } from "./breadcrumb-label";
import { CommandPalette } from "./command-palette";
import { DocumentTitle } from "./document-title";
import { InstanceChip } from "./instance-chip";
import { visibleNavGroups } from "./nav";
import { ThemeToggle } from "./theme-toggle";
import { UpdateIndicator } from "./update-indicator";
import { UserMenu } from "./user-menu";
import { PageSkeleton } from "../shared/page-skeleton";
import { EmailSetupBanner } from "../shared/email-setup-notice";

function isActivePath(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Below 1024px the rail keeps only its icons. */
function useCompactRail(): boolean {
  const [compact, setCompact] = useState(() => window.innerWidth < 1024);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 1023px)");
    const onChange = () => setCompact(query.matches);
    query.addEventListener("change", onChange);
    onChange();
    return () => query.removeEventListener("change", onChange);
  }, []);

  return compact;
}

function PageLoader() {
  return <PageSkeleton rows={2} label="Loading page" />;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function AppSidebar() {
  const { pathname } = useLocation();
  const { data: instance } = useInstance();
  const instanceName = instance?.application?.name?.trim() || "OrbitID";
  const organizations = useShowOrganizations();
  const groups = useMemo(() => visibleNavGroups({ organizations }), [organizations]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="px-2 pt-2 pb-0">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild tooltip={instanceName}>
              <Link to="/" className="gap-2.5">
                <AppIcon className="size-7" />
                <span className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate text-sm font-semibold text-foreground">{instanceName}</span>
                  <span className="truncate font-data text-[0.6875rem] text-sidebar-foreground/85">
                    {hostOf(getApiUrl())}
                  </span>
                </span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent className="gap-0 px-0 pt-2">
        {groups.map((group, groupIndex) => (
          <SidebarGroup key={group.label ?? `group-${groupIndex}`} className="py-1">
            {group.label ? <SidebarGroupLabel>{group.label}</SidebarGroupLabel> : null}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={`${group.label ?? "main"}-${item.href}`}>
                    <SidebarMenuButton asChild isActive={isActivePath(pathname, item.href)} tooltip={item.title}>
                      <NavLink to={item.href} end={item.href === "/"} onPointerEnter={() => preloadRoute(item.href)} onFocus={() => preloadRoute(item.href)}>
                        <item.icon aria-hidden />
                        <span className="truncate">{item.title}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

export function AppShell() {
  const compact = useCompactRail();
  const [open, setOpen] = useState(!compact);

  useEffect(() => {
    setOpen(!compact);
  }, [compact]);

  return (
    <SidebarProvider open={open} onOpenChange={setOpen}>
      <DocumentTitle />
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-card focus:px-3 focus:py-1.5 focus:text-sm focus:font-medium"
      >
        Skip to content
      </a>
      <AppSidebar />
      <SidebarInset className="min-w-0">
        <BreadcrumbLabelProvider>
          <header className="sticky top-0 z-20 grid h-12 shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b border-border bg-background px-3">
            <SidebarTrigger className="text-muted-foreground" />
            <div className="hidden min-w-0 overflow-hidden sm:block">
              <Breadcrumbs />
            </div>
            <div className="flex min-w-0 items-center justify-self-end gap-1.5">
              <UpdateIndicator />
              <InstanceChip className="flex min-w-0 items-center" />
              <CommandPalette />
              <ThemeToggle />
              <UserMenu />
            </div>
          </header>
          <EmailSetupBanner />
          <div id="main-content" className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col gap-6 px-6 py-6">
            <PageFallback.Provider value={<PageLoader />}>
              <Suspense fallback={<PageLoader />}>
                <Outlet />
              </Suspense>
            </PageFallback.Provider>
          </div>
        </BreadcrumbLabelProvider>
      </SidebarInset>
    </SidebarProvider>
  );
}
