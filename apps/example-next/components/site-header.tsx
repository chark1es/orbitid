"use client";

import Link from "next/link";
import {
  Protect,
  SignedIn,
  SignedOut,
  OrganizationSwitcher,
  UserButton,
} from "@orbitid/react";

export function SiteHeader() {
  return (
    <header className="border-b">
      <div className="container-page flex min-h-16 flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
        <nav className="flex min-w-0 flex-wrap items-center gap-x-6 gap-y-1 text-sm font-medium">
          <Link href="/" className="min-w-0 truncate text-base font-semibold">
            OrbitID Example
          </Link>
          <SignedIn>
            <Link href="/dashboard" className="text-muted-foreground hover:text-foreground">
              Dashboard
            </Link>
            <Protect permission="org:sys_memberships:manage">
              <Link href="/admin" className="text-muted-foreground hover:text-foreground">
                Admin
              </Link>
            </Protect>
          </SignedIn>
        </nav>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-3">
          <SignedIn>
            <OrganizationSwitcher />
            <UserButton />
          </SignedIn>
          <SignedOut>
            <Link href="/sign-in" className="text-sm text-muted-foreground hover:text-foreground">
              Sign in
            </Link>
            <Link
              href="/sign-up"
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
            >
              Sign up
            </Link>
          </SignedOut>
        </div>
      </div>
    </header>
  );
}
