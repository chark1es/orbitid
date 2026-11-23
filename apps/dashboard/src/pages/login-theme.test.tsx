import type { ReactNode } from "react";
import indexHtml from "../../index.html?raw";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { ThemeProvider, initTheme, useTheme } from "@orbitid/ui";
import type { Appearance, BaseTheme } from "@orbitid/react";
import App from "../App";
import { AuthProvider } from "../lib/auth";

// The real `AccountSignIn` runs; only the SDK under it is stubbed. The stub reports which scheme the form was given.
vi.mock("@orbitid/js", () => ({
  OrbitID: class {
    load() {
      return Promise.resolve();
    }
  },
}));
vi.mock("@orbitid/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orbitid/react")>();
  return {
    ...actual,
    OrbitIDProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
    useAuth: () => ({ isLoaded: false, isSignedIn: false }),
    SignIn: ({ appearance }: { appearance?: Appearance }) => {
      const themes = ([] as BaseTheme[]).concat(appearance?.baseTheme ?? []);
      const scheme = themes.flatMap((theme) => theme.classNames ?? []).find((name) => name === "dark" || name === "light");
      return <div data-testid="sdk-sign-in" data-scheme={scheme ?? "none"} />;
    },
  };
});

const realMatchMedia = window.matchMedia;

function osScheme(scheme: "light" | "dark") {
  window.matchMedia = ((query: string) => ({
    matches: scheme === "dark" && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function mockSignedOut() {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.includes("/v1/operator_sessions/status")) {
      return json({ object: "operator_status", operator_session: null, user: null, setup_required: false, console_unclaimed: false });
    }
    if (url.endsWith("/health")) return json({ status: "ok", publishable_key: "pk_test_demo" });
    return json({ data: [], total_count: 0 });
  });
}

let setThemeFromTest: ReturnType<typeof useTheme>["setTheme"] = () => undefined;
function ThemeHandle() {
  setThemeFromTest = useTheme().setTheme;
  return null;
}

/** Boots the way `main.tsx` does: apply the stored theme before the first render, then mount under the provider. */
function renderLogin() {
  initTheme();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider defaultTheme="system" storageKey="orbitid-theme">
      <ThemeHandle />
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/login"]}>
          <AuthProvider>
            <App />
          </AuthProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

afterEach(() => {
  window.matchMedia = realMatchMedia;
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
});

describe("the pre-paint script in index.html", () => {
  // The first inline script runs before any CSS or app code, so the first frame already has the right scheme.
  const source = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]!).find((code) => code.includes("orbitid-theme"));

  function prePaint() {
    document.documentElement.className = "";
    document.documentElement.style.colorScheme = "";
    new Function(source!)();
    return { dark: document.documentElement.classList.contains("dark"), scheme: document.documentElement.style.colorScheme };
  }

  it("is there", () => {
    expect(source).toBeTruthy();
  });

  it.each([
    { saved: null, os: "light", dark: false },
    { saved: null, os: "dark", dark: true },
    { saved: "system", os: "dark", dark: true },
    { saved: "light", os: "dark", dark: false },
    { saved: "dark", os: "light", dark: true },
    { saved: "garbage", os: "dark", dark: true },
  ] as const)("applies $saved on a $os system the way the app will", ({ saved, os, dark }) => {
    osScheme(os);
    if (saved) localStorage.setItem("orbitid-theme", saved);
    expect(prePaint()).toEqual({ dark, scheme: dark ? "dark" : "light" });
    // The app's own `initTheme()` must agree, or the page would flip once React mounts.
    document.documentElement.className = "";
    expect(initTheme()).toBe(dark ? "dark" : "light");
  });
});

describe("sign-in screen in light and dark mode", () => {
  // The login page lazy-loads the real account form. Load it once up front so a busy test run does not outlast
  // `findBy`'s one-second wait on the first render.
  beforeAll(async () => {
    await import("./_login/account-sign-in");
  }, 30_000);

  it("renders dark when the operator chose dark, and hands the console's scheme to the account form", async () => {
    osScheme("light");
    localStorage.setItem("orbitid-theme", "dark");
    mockSignedOut();
    renderLogin();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(await screen.findByText("Sign in to the console")).toBeTruthy();
    expect((await screen.findByTestId("sdk-sign-in")).dataset.scheme).toBe("dark");
  });

  it("follows the operating system when nothing is saved", async () => {
    osScheme("dark");
    mockSignedOut();
    renderLogin();

    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect((await screen.findByTestId("sdk-sign-in")).dataset.scheme).toBe("dark");
  });

  it("keeps a saved light choice on a dark operating system, form included", async () => {
    osScheme("dark");
    localStorage.setItem("orbitid-theme", "light");
    mockSignedOut();
    renderLogin();

    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect((await screen.findByTestId("sdk-sign-in")).dataset.scheme).toBe("light");
  });

  it("switches the form with the page when the theme changes on the sign-in screen", async () => {
    osScheme("light");
    mockSignedOut();
    renderLogin();
    expect((await screen.findByTestId("sdk-sign-in")).dataset.scheme).toBe("light");

    act(() => setThemeFromTest("dark"));
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(screen.getByTestId("sdk-sign-in").dataset.scheme).toBe("dark");
  });
});
