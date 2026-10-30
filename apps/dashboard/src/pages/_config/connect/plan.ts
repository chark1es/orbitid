import {
  type FrameworkKey,
  frameworkLabel,
  frameworkInstall,
  type ConnectTarget,
  type ConnectPlan,
} from "./model";
import { nextjsBlocks, reactBlocks, expressBlocks, nodeBlocks } from "./blocks";

const SAMPLES: Record<FrameworkKey, { title: string; code: string }> = {
  nextjs: {
    title: "app/layout.tsx",
    code: [
      'import { OrbitIDProvider } from "@orbitid/nextjs/server";',
      "",
      "export default function RootLayout({ children }: { children: React.ReactNode }) {",
      "  return (",
      '    <html lang="en">',
      "      <body>",
      "        <OrbitIDProvider>{children}</OrbitIDProvider>",
      "      </body>",
      "    </html>",
      "  );",
      "}",
    ].join("\n"),
  },
  react: {
    title: "src/App.tsx",
    code: [
      'import { OrbitIDProvider, SignedIn, SignedOut, SignIn, UserButton } from "@orbitid/react";',
      'import "@orbitid/ui/styles.css";',
      "",
      "export function App() {",
      "  return (",
      "    <OrbitIDProvider",
      "      publishableKey={import.meta.env.VITE_ORBITID_PUBLISHABLE_KEY}",
      '      signInUrl={import.meta.env.VITE_ORBITID_SIGN_IN_URL ?? "/sign-in"}',
      "    >",
      "      <SignedIn>",
      "        <UserButton />",
      "      </SignedIn>",
      "      <SignedOut>",
      '        <SignIn routing="path" path="/sign-in" />',
      "      </SignedOut>",
      "    </OrbitIDProvider>",
      "  );",
      "}",
    ].join("\n"),
  },
  express: {
    title: "src/server.ts",
    code: [
      'import express from "express";',
      'import { createOrbitId } from "@orbitid/node";',
      "",
      "const orbit = createOrbitId();",
      "const app = express();",
      "",
      "app.get(\"/me\", orbit.requireAuth(), (req, res) => res.json({ userId: req.auth!.userId }));",
      "app.post(",
      '  "/api/webhooks",',
      '  express.raw({ type: "application/json" }),',
      "  orbit.webhookHandler(async (event) => {",
      '    if (event.type === "user.created") console.log(event.data.id);',
      "  }),",
      ");",
      "",
      "app.listen(3000);",
    ].join("\n"),
  },
  node: {
    title: "list-users.ts",
    code: [
      'import { createOrbitId } from "@orbitid/node";',
      "",
      "const orbit = createOrbitId();",
      "const result = await orbit.client.users.getUserList({ limit: 20, orderBy: \"-created_at\" });",
      "",
      'console.log(`${result.totalCount} users`);',
      "for (const user of result.data) console.log(user.id, user.firstName ?? \"\");",
    ].join("\n"),
  },
};

export function buildConnectPlan(framework: FrameworkKey, target: ConnectTarget): ConnectPlan {
  const blocks =
    framework === "nextjs" ? nextjsBlocks(target)
    : framework === "react" ? reactBlocks(target)
    : framework === "express" ? expressBlocks(target)
    : nodeBlocks(target);
  return {
    framework,
    label: frameworkLabel(framework),
    install: frameworkInstall(framework),
    blocks,
    sample: SAMPLES[framework],
  };
}

/* ------------------------------------------------------------------------------------------------
 * Server summary (read-only)
 * ---------------------------------------------------------------------------------------------- */
