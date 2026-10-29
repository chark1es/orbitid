import type { Metadata } from "next";
import { initialAuthState } from "@orbitid/nextjs/server";
import { AppShell } from "@/components/app-shell";
import { PlaygroundProvider } from "@/components/playground-provider";
import { ThemeProvider } from "@/components/theme-provider";
import { getInstanceStatus } from "@/lib/env";
import "./globals.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "OrbitID test site",
  description: "Exercise a running OrbitID instance: sign-in, sessions, organizations, webhooks and the Backend API.",
};

const THEME_SCRIPT = `try{var t=localStorage.getItem("orbitid-playground-theme");if(t==="dark"){document.documentElement.classList.add("dark")}}catch(e){}`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const status = await getInstanceStatus();
  const publishableKey = status.publishableKey;
  const initialState = publishableKey ? await initialAuthState() : undefined;
  const shell = (
    <AppShell status={status} hasProvider={Boolean(publishableKey)}>
      {children}
    </AppShell>
  );

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body>
        <ThemeProvider>
          {publishableKey ? (
            <PlaygroundProvider publishableKey={publishableKey} initialState={initialState}>
              {shell}
            </PlaygroundProvider>
          ) : (
            shell
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
