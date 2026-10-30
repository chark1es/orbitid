import { describe, expect, it } from "vitest";
import { defaultInstanceSettings } from "@orbitid/shared";
import {
  FRAMEWORKS,
  buildConnectPlan,
  connectTarget,
  renderBlockWithHeader,
  renderEnvBlock,
  renderEnvBlocks,
  serverSummary,
  setupChecks,
  signInUrlFor,
  SECRET_KEY_PLACEHOLDER,
} from "../connect";

const target = connectTarget({
  publishableKey: "pk_test_abc123",
  apiUrl: "http://localhost:4000/",
  homeUrl: "https://app.example.com/",
});

describe("connect target", () => {
  it("trims trailing slashes and derives sign-in and sign-up URLs from the home URL", () => {
    expect(target.apiUrl).toBe("http://localhost:4000");
    expect(target.homeUrl).toBe("https://app.example.com");
    expect(target.signInUrl).toBe("https://app.example.com/sign-in");
    expect(target.signUpUrl).toBe("https://app.example.com/sign-up");
  });

  it("falls back to a placeholder origin when no home URL is set", () => {
    expect(signInUrlFor(undefined)).toBe("https://your-app.example.com/sign-in");
    expect(signInUrlFor("https://app.example.com/", "/sign-up")).toBe("https://app.example.com/sign-up");
  });
});

describe("environment blocks", () => {
  it("uses the Next.js variable names and marks the secret block server-only", () => {
    const plan = buildConnectPlan("nextjs", target);
    expect(plan.install).toBe("bun add @orbitid/nextjs");

    const browser = plan.blocks.find((block) => block.id === "browser")!;
    expect(browser.heading).toBe("Website · browser (public)");
    expect(browser.filename).toBe(".env.local");
    expect(browser.variables.map((variable) => variable.name)).toEqual([
      "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY",
      "NEXT_PUBLIC_ORBITID_API_URL",
      "NEXT_PUBLIC_ORBITID_SIGN_IN_URL",
      "NEXT_PUBLIC_ORBITID_SIGN_UP_URL",
    ]);
    expect(browser.where).toMatch(/\.env\.local/);

    const backend = plan.blocks.find((block) => block.id === "backend")!;
    expect(backend.heading).toBe("Website · backend (secret)");
    expect(backend.variables.map((variable) => variable.name)).toEqual([
      "ORBITID_SECRET_KEY",
      "ORBITID_API_URL",
      "ORBITID_WEBHOOK_SECRET",
      "ORBITID_JWT_KEY",
    ]);
    expect(backend.variables.some((variable) => variable.optional)).toBe(true);
    expect(backend.note).toMatch(/never in a bundle/);
  });

  it("changes the variable names per framework and never puts the secret in the browser block", () => {
    const react = buildConnectPlan("react", target);
    expect(react.blocks[0]!.variables.map((variable) => variable.name)).toContain("VITE_ORBITID_PUBLISHABLE_KEY");
    expect(react.install).toBe("bun add @orbitid/react @orbitid/backend");

    const express = buildConnectPlan("express", target);
    expect(express.blocks[0]!.variables.map((variable) => variable.name)).toContain("ORBITID_PUBLISHABLE_KEY");
    expect(express.install).toBe("bun add @orbitid/node express");

    const node = buildConnectPlan("node", target);
    expect(node.install).toBe("bun add @orbitid/node");

    for (const framework of FRAMEWORKS) {
      const plan = buildConnectPlan(framework.key, target);
      const browserNames = plan.blocks.find((block) => block.id === "browser")!.variables.map((variable) => variable.name);
      expect(browserNames.some((name) => name.includes("SECRET") || name.includes("JWT_KEY"))).toBe(false);
      expect(plan.blocks.every((block) => block.where.length > 0)).toBe(true);
    }
  });

  it("keeps the secret key a placeholder, because the dashboard does not hold it", () => {
    const plan = buildConnectPlan("nextjs", target);
    const backend = plan.blocks.find((block) => block.id === "backend")!;
    const secret = backend.variables.find((variable) => variable.name === "ORBITID_SECRET_KEY")!;

    expect(secret.value).toBe(SECRET_KEY_PLACEHOLDER);
    expect(secret.comment).toMatch(/keys command/);
    // No real key can be copied out of the page: the only value is the placeholder.
    expect(renderEnvBlock(backend)).toContain(`ORBITID_SECRET_KEY=${SECRET_KEY_PLACEHOLDER}`);
    expect(renderEnvBlock(backend)).not.toMatch(/sk_(live|test)_[A-Za-z0-9]{8,}/);
  });

  it("comments out optional values and keeps the webhook hint", () => {
    const plan = buildConnectPlan("nextjs", target);
    const backend = plan.blocks.find((block) => block.id === "backend")!;
    const text = renderEnvBlock(backend);
    expect(text).toContain("# ORBITID_JWT_KEY=");
    expect(text).toContain("# The webhook secret is per endpoint");
    expect(text).toContain("ORBITID_WEBHOOK_SECRET=");
  });

  it("joins every block for copy all", () => {
    const plan = buildConnectPlan("nextjs", target);
    const all = renderEnvBlocks(plan.blocks);
    expect(all).toContain("NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=pk_test_abc123");
    expect(all).toContain(`ORBITID_SECRET_KEY=${SECRET_KEY_PLACEHOLDER}`);
    expect(all.split("\n\n")).toHaveLength(2);
  });

  it("carries the heading and destination when one block is copied", () => {
    const plan = buildConnectPlan("nextjs", target);
    const backend = plan.blocks.find((block) => block.id === "backend")!;
    const text = renderBlockWithHeader(backend);
    expect(text.split("\n")[0]).toBe("# Website · backend (secret)");
    expect(text.split("\n")[1]).toMatch(/^# /);
    expect(text).toContain(`ORBITID_SECRET_KEY=${SECRET_KEY_PLACEHOLDER}`);
  });
});

describe("server summary", () => {
  it("reports the database, URL, email provider and private-network state without the encryption key", () => {
    const settings = defaultInstanceSettings();
    settings.email.provider = "console";
    settings.application.developmentMode = false;
    const rows = serverSummary({ apiUrl: "http://localhost:4000", database: "sqlite", settings });
    const labels = rows.map((row) => row.label);
    expect(labels).toEqual(["Database", "Base URL", "Email delivery", "Private networks"]);
    expect(rows[0]!.value).toBe("SQLite");
    expect(rows[1]!.value).toBe("http://localhost:4000");
    expect(rows[2]!.value).toBe("Not configured");
    expect(rows[3]!.value).toBe("Blocked");
    expect(JSON.stringify(rows)).not.toMatch(/encryption/i);
  });

  it("names the automatic provider by what it resolves to", () => {
    const settings = defaultInstanceSettings();
    settings.email.resendApiKey = "••••";
    const rows = serverSummary({ apiUrl: "http://localhost:4000", database: "postgres", settings });
    expect(rows.find((row) => row.label === "Email delivery")?.value).toBe("Resend");
    expect(rows.find((row) => row.label === "Database")?.value).toBe("Postgres");
  });
});

describe("setup checks", () => {
  const base = {
    apiUrl: "http://localhost:4000",
    health: { status: "ok", publishableKey: "pk_test_abc123", database: "postgres" as const },
    healthError: null,
    environment: { firstFactors: ["password", "email_code"], signUpMode: "public", applicationName: "Acme" },
    environmentError: null,
    publishableKey: "pk_test_abc123",
    sessionActive: true,
    settings: defaultInstanceSettings(),
  };

  it("reports a healthy instance", () => {
    const checks = setupChecks(base);
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    expect(byId.health?.state).toBe("ok");
    expect(byId["publishable-key"]?.state).toBe("ok");
    expect(byId["operator-session"]?.state).toBe("ok");
    expect(byId.environment?.state).toBe("ok");
    expect(byId.environment?.detail).toContain("password, email code");
  });

  it("fails clearly when the server does not answer", () => {
    const checks = setupChecks({
      ...base,
      health: null,
      healthError: "Health check failed (503)",
      environment: null,
      environmentError: "The server did not answer.",
      publishableKey: "",
      sessionActive: false,
    });
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    expect(byId.health?.state).toBe("fail");
    expect(byId.health?.detail).toContain("Health check failed (503)");
    expect(byId["publishable-key"]?.state).toBe("fail");
    expect(byId["operator-session"]?.state).toBe("warn");
    expect(byId.environment?.state).toBe("fail");
  });

  it("warns about console email and a home URL that is not an allowed origin", () => {
    const settings = defaultInstanceSettings();
    settings.application.homeUrl = "https://app.example.com";
    settings.application.developmentMode = false;
    const checks = setupChecks({ ...base, settings });
    const byId = Object.fromEntries(checks.map((check) => [check.id, check]));
    expect(byId.email?.state).toBe("warn");
    expect(byId.email?.detail).toMatch(/delivery is disabled/);
    expect(byId.origins?.state).toBe("warn");
    expect(byId.origins?.detail).toContain("https://app.example.com");
  });
});
