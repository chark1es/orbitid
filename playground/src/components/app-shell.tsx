"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";
import {
  Building2,
  DatabaseZap,
  Hourglass,
  KeyRound,
  LogIn,
  Menu,
  Moon,
  ScanSearch,
  SlidersHorizontal,
  Sun,
  Terminal,
  UserPlus,
  UserRound,
  Webhook,
  X,
} from "lucide-react";
import { cn } from "@orbitid/ui";
import { useAuth } from "@orbitid/react";
import type { InstanceStatus } from "@/lib/env";
import { useTheme } from "./theme-provider";
import { StatusChip } from "./status-chip";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const NAV_GROUPS: NavGroup[] = [
  { label: "Setup", items: [{ href: "/", label: "Setup", icon: SlidersHorizontal }] },
  {
    label: "Sign in",
    items: [
      { href: "/sign-in", label: "Sign in", icon: LogIn },
      { href: "/sign-up", label: "Sign up", icon: UserPlus },
      { href: "/waitlist", label: "Waitlist", icon: Hourglass },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/account", label: "Account", icon: UserRound },
      { href: "/api-keys", label: "API keys", icon: KeyRound },
    ],
  },
  { label: "Organizations", items: [{ href: "/organizations", label: "Organizations", icon: Building2 }] },
  { label: "Inspector", items: [{ href: "/inspector", label: "Inspector", icon: ScanSearch }] },
  { label: "API lab", items: [{ href: "/api-lab", label: "API lab", icon: Terminal }] },
  { label: "Webhooks", items: [{ href: "/webhooks", label: "Webhooks", icon: Webhook }] },
  { label: "Seed data", items: [{ href: "/seed", label: "Seed data", icon: DatabaseZap }] },
];

function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

function currentLabel(pathname: string): string {
  const match = NAV_GROUPS.flatMap((group) => group.items)
    .filter((item) => isActive(pathname, item.href))
    .sort((left, right) => right.href.length - left.href.length)[0];
  return match?.label ?? "Setup";
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${next} theme`}
      title={`Switch to ${next} theme`}
      className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      {theme === "dark" ? <Sun className="size-4" aria-hidden="true" /> : <Moon className="size-4" aria-hidden="true" />}
    </button>
  );
}

function SessionIndicator() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  if (!isLoaded) {
    return <span className="hidden h-4 w-20 animate-pulse rounded-sm bg-muted sm:block" aria-hidden="true" />;
  }
  if (!isSignedIn) {
    return (
      <Link href="/sign-in" className="text-sm text-muted-foreground hover:text-foreground">
        Sign in
      </Link>
    );
  }
  return (
    <Link
      href="/account"
      className="hidden items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground sm:inline-flex"
      title={`Signed in as ${userId}`}
    >
      <UserRound className="size-4" aria-hidden="true" />
      <span className="font-data hidden text-xs lg:inline">{userId}</span>
    </Link>
  );
}

function instanceHost(status: InstanceStatus): string {
  return status.frontendApi ? status.frontendApi.replace(/^https?:\/\//, "") : "no key";
}

function InstanceChip({ status }: { status: InstanceStatus }) {
  const database = status.health.database;
  const reachable = status.health.reachable;
  if (!status.frontendApi) {
    return (
      <div className="flex min-w-0 items-center rounded-sm border px-2 py-1">
        <StatusChip kind="needs-config" label="No instance connected" />
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 rounded-sm border px-2 py-1">
      <span className="hidden text-xs text-muted-foreground xl:inline">Instance</span>
      <span className="font-data max-w-[130px] truncate text-xs text-foreground xl:max-w-none">{instanceHost(status)}</span>
      {reachable ? (
        <>
          <span aria-hidden="true" className="hidden text-border lg:inline">
            /
          </span>
          <span className="font-data hidden truncate text-xs text-muted-foreground lg:inline">
            {database ?? "database not reported"}
          </span>
        </>
      ) : (
        <StatusChip kind="failed" label="Unreachable" className="shrink-0" />
      )}
    </div>
  );
}

function RailNav({ pathname, variant }: { pathname: string; variant: "rail" | "panel" }) {
  const rail = variant === "rail";
  return (
    <nav aria-label="Test pages" className={cn("flex flex-col gap-5", rail ? "" : "px-3 py-3")}>
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p
            className={cn(
              "mb-1.5 px-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-sidebar-foreground/60 uppercase",
              rail ? "hidden lg:block" : "",
            )}
          >
            {group.label}
          </p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const active = isActive(pathname, item.href);
              const Icon = item.icon;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    title={rail ? item.label : undefined}
                    className={cn(
                      "flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors",
                      rail ? "justify-center lg:justify-start" : "justify-start",
                      active
                        ? "bg-sidebar-accent font-medium text-sidebar-primary"
                        : "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" aria-hidden="true" />
                    <span className={rail ? "hidden lg:inline" : ""}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function AppShell({
  status,
  hasProvider,
  children,
}: {
  status: InstanceStatus;
  hasProvider: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname() ?? "/";
  const [mobileOpen, setMobileOpen] = React.useState(false);

  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a href="#content" className="skip-link text-sm font-medium">
        Skip to content
      </a>

      <aside className="fixed inset-y-0 left-0 z-40 hidden w-16 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground md:flex lg:w-[232px]">
        <div className="flex h-12 shrink-0 items-center justify-center gap-2 border-b border-sidebar-border px-4 lg:justify-start">
          <Link href="/" className="flex items-baseline gap-2" aria-label="OrbitID test site">
            <span className="hidden text-base font-semibold tracking-tight lg:inline">OrbitID</span>
            <span className="text-base font-semibold tracking-tight lg:hidden" aria-hidden="true">
              O
            </span>
            <span className="hidden text-[0.6875rem] text-sidebar-foreground/60 lg:inline">Test site</span>
          </Link>
        </div>
        <div className="rail-scroll flex-1 overflow-y-auto py-3">
          <div className="px-2">
            <RailNav pathname={pathname} variant="rail" />
          </div>
        </div>
        <div className="hidden shrink-0 border-t border-sidebar-border px-4 py-3 text-[0.6875rem] text-sidebar-foreground/60 lg:block">
          Not for production. Every action hits the instance named above.
        </div>
      </aside>

      <div className="md:pl-16 lg:pl-[232px]">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-3 border-b bg-background px-3 sm:px-6">
          <button
            type="button"
            className="inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            aria-expanded={mobileOpen}
            aria-controls="mobile-nav"
            aria-label={mobileOpen ? "Close test pages menu" : "Open test pages menu"}
            onClick={() => setMobileOpen((open) => !open)}
          >
            {mobileOpen ? <X className="size-4" aria-hidden="true" /> : <Menu className="size-4" aria-hidden="true" />}
          </button>
          <p className="min-w-0 flex-1 truncate text-sm font-medium">{currentLabel(pathname)}</p>
          <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2 sm:gap-3">
            <div className="hidden min-w-0 sm:block">
              <InstanceChip status={status} />
            </div>
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border px-2 py-1 text-[0.6875rem] font-medium text-caution">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              <span className="md:hidden">Not for production</span>
              <span className="hidden md:inline">Test site, not for production</span>
            </span>
            <ThemeToggle />
            {hasProvider ? <SessionIndicator /> : null}
          </div>
        </header>

        {mobileOpen ? (
          <div id="mobile-nav" className="border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:hidden">
            <div className="space-y-1 border-b border-sidebar-border px-4 py-3">
              <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-sidebar-foreground/60 uppercase">
                Instance
              </p>
              <p className="font-data text-xs break-all">
                {status.frontendApi
                  ? `${instanceHost(status)} / ${status.health.reachable ? status.health.database ?? "database not reported" : "unreachable"}`
                  : "No instance connected"}
              </p>
              <p className="text-xs text-caution">Test site, not for production.</p>
            </div>
            <RailNav pathname={pathname} variant="panel" />
          </div>
        ) : null}

        <main id="content" tabIndex={-1} className="mx-auto w-full max-w-[1280px] px-4 py-6 sm:px-6 sm:py-8">
          {children}
        </main>
      </div>
    </div>
  );
}
