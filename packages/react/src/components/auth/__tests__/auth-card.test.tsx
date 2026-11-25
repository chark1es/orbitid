import { describe, expect, it } from "vitest";
import { AuthCard } from "../_shared/auth-card";
import { setupAuth, renderAuth } from "./fake-auth";

function headerOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="card-header"]') as HTMLElement;
}

describe("AuthCard header rhythm", () => {
  it("keeps one 24px gap between the header and the first field, with or without a subtitle", () => {
    const harness = setupAuth({ signedIn: false });
    const { container } = renderAuth(
      <AuthCard title="Sign in" subtitle="Enter your details to continue">
        <label htmlFor="email">Email address</label>
      </AuthCard>,
      harness,
    );
    expect(headerOf(container).className).toContain("pb-6");
    const bare = renderAuth(
      <AuthCard title="Check your email">
        <label htmlFor="code">Code</label>
      </AuthCard>,
      harness,
    );
    expect(headerOf(bare.container).className).toContain("pb-6");
  });

  it("puts the card on the component root, not on the host page", () => {
    const harness = setupAuth({ signedIn: false });
    const { container } = renderAuth(
      <AuthCard title="Sign in">
        <span />
      </AuthCard>,
      harness,
    );
    const root = container.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;
    expect(root.classList).toContain("orbitid-component");
    expect(root.querySelector('[data-slot="card"]')?.classList).toContain("orbitid-cardBox");
  });
});
