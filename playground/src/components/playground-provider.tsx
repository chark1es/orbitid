"use client";

import * as React from "react";
import { ClientOrbitIDProvider } from "@orbitid/nextjs";
import type { InitialAuthState } from "@orbitid/nextjs";
import { themes, type BaseTheme } from "@orbitid/react";
import { useTheme } from "./theme-provider";

const LIGHT_THEME: BaseTheme = {
  name: "light",
  classNames: ["light"],
  variables: {},
  layout: {},
  elements: {},
};

/** Keeps the prebuilt widgets on the same theme as the shell instead of the operating system. */
export function PlaygroundProvider({
  publishableKey,
  initialState,
  children,
}: {
  publishableKey: string;
  initialState?: InitialAuthState;
  children: React.ReactNode;
}) {
  const { theme } = useTheme();
  const appearance = React.useMemo(
    () => ({ baseTheme: theme === "dark" ? themes.dark : LIGHT_THEME }),
    [theme],
  );

  return (
    <ClientOrbitIDProvider
      publishableKey={publishableKey}
      initialState={initialState}
      appearance={appearance}
      signInFallbackRedirectUrl="/account"
      signUpFallbackRedirectUrl="/account"
    >
      {children}
    </ClientOrbitIDProvider>
  );
}
