import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { OrbitIDProvider } from "../../../provider";
import { dark, light } from "../../../appearance";
import { createFakeOrbitID, PK, renderWithProvider } from "../../../__tests__/helpers";
import { AuthCard } from "../_shared/auth-card";
import { SignIn } from "../sign-in";
import { authEnvironment, authUser, renderAuth, setupAuth } from "./fake-auth";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { ComponentRoot } from "../_shared/component-root";
import { OtpField } from "../_shared/otp-field";
import { ProviderIcon } from "../_shared/provider-icon";
import { UserVerificationModal } from "../user-verification-modal";

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

afterEach(() => {
  cleanup();
  window.matchMedia = realMatchMedia;
  document.documentElement.className = "";
});

const cardRoot = () => document.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;

describe("a component's baseTheme over the provider's", () => {
  it("renders a light card with no dark values when the provider is dark and the component light", async () => {
    osScheme("light");
    renderAuth(<SignIn routing="virtual" appearance={{ baseTheme: light }} />, setupAuth({ signedIn: false }), {
      appearance: { baseTheme: dark },
    });
    await screen.findByRole("heading", { level: 2 });
    expect(cardRoot().dataset.orbitTheme).toBe("light");
    expect(cardRoot().classList.contains("dark")).toBe(false);
    for (const name of ["--card", "--foreground", "--muted-foreground", "--border", "--input"]) {
      expect(cardRoot().style.getPropertyValue(name), name).toBe("");
    }
    // Only the instance brand color sets the primary, never the dark preset's near-white.
    expect(cardRoot().style.getPropertyValue("--primary")).not.toBe(dark.variables!.colorPrimary);
  });

  it("renders dark with dark values when the provider is light and the component dark", async () => {
    osScheme("light");
    renderAuth(<SignIn routing="virtual" appearance={{ baseTheme: dark }} />, setupAuth({ signedIn: false }), {
      appearance: { baseTheme: light },
    });
    await screen.findByRole("heading", { level: 2 });
    expect(cardRoot().dataset.orbitTheme).toBe("dark");
    expect(cardRoot().classList.contains("dark")).toBe(true);
    expect(cardRoot().style.getPropertyValue("--card")).toBe(dark.variables!.colorBackground);
  });
});

describe("the host page", () => {
  it("gets no OrbitID variables, classes or rootBox from the provider's appearance", async () => {
    renderAuth(
      <>
        <p data-testid="host">host markup</p>
        <SignIn routing="virtual" />
      </>,
      setupAuth({ signedIn: false }),
      { appearance: { baseTheme: dark, variables: { spacingUnit: "0.5rem", fontSize: "18px", colorPrimary: "#2563eb" }, elements: { rootBox: "host-leak" } } },
    );
    await screen.findByRole("heading", { level: 2 });
    for (let node: HTMLElement | null = screen.getByTestId("host"); node && node !== document.body; node = node.parentElement) {
      expect(node.getAttribute("style") ?? "", "inline variables").not.toMatch(/--/);
      expect(node.classList.contains("host-leak")).toBe(false);
      expect(node.classList.contains("dark")).toBe(false);
    }
    // The component still gets everything.
    expect(cardRoot().style.getPropertyValue("--spacing")).toBe("0.5rem");
    expect(cardRoot().style.getPropertyValue("--font-scale")).toBe("1.2857");
    expect(cardRoot().classList.contains("host-leak")).toBe(true);
  });
});

describe("loading state", () => {
  it("renders the skeleton inside the component root, with the forced scheme and variables", () => {
    osScheme("light");
    const instance = createFakeOrbitID({ loaded: false, environment: authEnvironment() });
    instance.loadGate = new Promise(() => {});
    renderWithProvider(<SignIn routing="virtual" />, {
      instance,
      providerProps: { appearance: { baseTheme: dark, variables: { borderRadius: "3px" } } },
    });
    const root = document.querySelector('[data-orbit-component="auth-loading"]') as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute("aria-busy")).toBe("true");
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.getPropertyValue("--radius")).toBe("3px");
    expect(root.querySelector('[data-slot="skeleton"]')).not.toBeNull();
  });
});

describe("a forced light component", () => {
  it("carries the light class on a page that declares nothing while the OS is dark", () => {
    osScheme("dark");
    renderAuth(<AuthCard title="Sign in">fields</AuthCard>, setupAuth({ signedIn: false }), { appearance: { baseTheme: light } });
    expect(cardRoot().dataset.orbitTheme).toBe("light");
    expect(cardRoot().classList.contains("light")).toBe(true);
  });

  it("does the same for a branding theme of light", () => {
    osScheme("dark");
    const environment = authEnvironment();
    environment.displayConfig.theme = "light";
    renderAuth(<AuthCard title="Sign in">fields</AuthCard>, setupAuth({ signedIn: false, environment }));
    expect(cardRoot().classList.contains("light")).toBe(true);
  });
});

describe("rootBox", () => {
  it("is applied once, and unstyled drops the layout classes but keeps the stable root classes", () => {
    renderAuth(<AuthCard title="Sign in">fields</AuthCard>, setupAuth({ signedIn: false }), {
      appearance: { elements: { rootBox: [{ className: "mine" }, { unstyled: true }] } },
    });
    const classes = cardRoot().className.split(" ");
    expect(classes.filter((name) => name === "mine")).toHaveLength(1);
    expect(classes).toEqual(expect.arrayContaining(["orbitid-root", "orbitid-component", "orbitid-rootBox", "mine"]));
    expect(classes).not.toContain("items-center");
  });
});

describe("server rendering", () => {
  it("hydrates an AuthCard with an appearance applied without a mismatch", async () => {
    const appearance = { baseTheme: dark, variables: { colorPrimary: "#2563eb", borderRadius: "10px" }, elements: { cardBox: "probe-card" } };
    const ui = (instance: ReturnType<typeof setupAuth>["instance"]) => (
      <OrbitIDProvider publishableKey={PK} orbit={instance} appearance={appearance}>
        <AuthCard title="Sign in" subtitle="Welcome back">
          <span>fields</span>
        </AuthCard>
      </OrbitIDProvider>
    );
    const html = renderToString(ui(setupAuth({ signedIn: false }).instance));
    expect(html).toContain("probe-card");
    expect(html).toContain("--radius:10px");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const recoverable = vi.fn();
    let root: ReturnType<typeof hydrateRoot> | undefined;
    await act(async () => {
      root = hydrateRoot(container, ui(setupAuth({ signedIn: false }).instance), { onRecoverableError: recoverable });
    });
    expect(recoverable).not.toHaveBeenCalled();
    expect(errors.mock.calls.filter((call) => /hydrat/i.test(String(call[0])))).toEqual([]);
    expect(container.querySelector(".probe-card")).not.toBeNull();
    act(() => root?.unmount());
    errors.mockRestore();
    container.remove();
  });
});

describe("pop-ups keep their scheme and variables under unstyled", () => {
  it.each([
    ["global unstyled", { unstyled: true }],
    ["modalContent: { unstyled: true }", { elements: { modalContent: { unstyled: true } } }],
  ] as const)("%s", (_label, extra) => {
    osScheme("light");
    // As inside the user profile: the dialog opens from within a component root.
    renderAuth(
      <ComponentRoot component="probe">
        <ConfirmDialog open onOpenChange={() => {}} title="Remove passkey?" onConfirm={() => {}} />
      </ComponentRoot>,
      setupAuth({ signedIn: false }),
      {
        appearance: { baseTheme: dark, variables: { colorPrimary: "#2563eb" }, ...extra },
      },
    );
    const dialog = screen.getByRole("alertdialog");
    const classes = dialog.className.split(" ");
    expect(classes).toContain("dark");
    expect(classes).toContain("orbitid-modalContent");
    const scope = classes.find((name) => name.startsWith("orbitid-scope-"));
    expect(scope).toBeDefined();
    expect(document.head.querySelector(`style[data-orbitid-scope="${scope}"]`)?.textContent).toContain("--primary:#2563eb");
    // OrbitID's own styling classes are gone.
    expect(classes).not.toContain("bg-popover");
  });
});

describe("a standalone <UserVerificationModal/>", () => {
  it("gets the provider's elements, variables and scheme", async () => {
    osScheme("light");
    renderAuth(<UserVerificationModal open />, setupAuth({ user: authUser() }), {
      appearance: { baseTheme: dark, variables: { colorPrimary: "#2563eb" }, elements: { modalContent: "probe-modal" } },
    });
    const dialog = await screen.findByRole("dialog");
    const classes = dialog.className.split(" ");
    expect(classes).toEqual(expect.arrayContaining(["probe-modal", "orbitid-modalContent", "dark"]));
    const scope = classes.find((name) => name.startsWith("orbitid-scope-"))!;
    expect(document.head.querySelector(`style[data-orbitid-scope="${scope}"]`)?.textContent).toContain("--primary:#2563eb");
  });

  it("takes its own appearance prop over the provider's", async () => {
    renderAuth(<UserVerificationModal open appearance={{ elements: { modalContent: "probe-prop" } }} />, setupAuth({ user: authUser() }), {
      appearance: { elements: { modalContent: "probe-provider" } },
    });
    const dialog = await screen.findByRole("dialog");
    expect(dialog.className).toContain("probe-provider");
    expect(dialog.className).toContain("probe-prop");
  });
});

describe("parts that are not plain primitives", () => {
  it("apply style and unstyled to the OTP group and slots, the provider icon and the logo mark", () => {
    renderAuth(
      <AuthCard title="Check your email">
        <OtpField value="" onChange={() => {}} label="Code" />
        <ProviderIcon provider="google" {...elementPropsForTest("socialButtonsProviderIcon")} />
      </AuthCard>,
      setupAuth({ signedIn: false }),
      {
        appearance: {
          elements: {
            formFieldInputGroup: { style: { gap: "11px" } },
            otpCodeFieldInput: { unstyled: true, className: "my-slot" },
            socialButtonsProviderIcon: { style: { opacity: "0.5" } },
            logoImage: { unstyled: true, className: "my-logo" },
          },
        },
      },
    );
    expect((document.querySelector(".orbitid-formFieldInputGroup") as HTMLElement).style.gap).toBe("11px");
    const slot = document.querySelector('[data-slot="input-otp-slot"]') as HTMLElement;
    expect(slot.className).toContain("my-slot");
    expect(slot.className).not.toContain("size-[34px]");
    expect(slot.className).not.toContain("size-10");
    expect((document.querySelector("svg.orbitid-socialButtonsProviderIcon") as SVGElement).style.opacity).toBe("0.5");
    const logo = document.querySelector("svg.orbitid-logoImage") as SVGElement;
    expect(logo.getAttribute("class")).toContain("my-logo");
    expect(logo.getAttribute("class")).not.toMatch(/\bsize-(4|9)\b/);
  });
});

/** `ep()` props for a key, the way a component would spread them. */
function elementPropsForTest(key: string) {
  return { "data-orbitid-element": key, className: "size-4" };
}
