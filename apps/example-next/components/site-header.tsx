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
      <div className="container-page flex h-16 items-center justify-between gap-4">
        <nav className="flex items-center gap-6 text-sm font-medium">
          <Link href="/" className="text-base font-semibold">
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
        <div className="flex items-center gap-3">
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
