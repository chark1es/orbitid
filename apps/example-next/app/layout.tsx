import type { Metadata } from "next";
import { OrbitIDProvider } from "@orbitid/nextjs/server";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

export const metadata: Metadata = {
  title: "OrbitID Next.js Example",
  description: "App Router demo for @orbitid/nextjs, @orbitid/react and the OrbitID server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground antialiased">
        <OrbitIDProvider>
          <SiteHeader />
          <main className="container-page py-10">{children}</main>
        </OrbitIDProvider>
      </body>
    </html>
  );
}
