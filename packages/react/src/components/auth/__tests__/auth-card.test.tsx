import { describe, expect, it } from "vitest";
import { AuthCard } from "../_shared/auth-card";
import { setupAuth, renderAuth } from "./fake-auth";

function headerOf(container: HTMLElement): HTMLElement {
  return container.querySelector('[data-slot="card-header"]') as HTMLElement;
}

describe("AuthCard header rhythm", () => {
  it("lands the subtitle on the 16px form rhythm above the first field", () => {
    const harness = setupAuth({ signedIn: false });
    const { container } = renderAuth(
      <AuthCard title="Sign in" subtitle="Enter your details to continue">
        <label htmlFor="email">Email address</label>
      </AuthCard>,
      harness,
    );
    // The line boxes already read as ~10px of air; 6px of header padding makes it 16px, matching the
    // gap the shared form uses between its fields.
    expect(headerOf(container).className).toContain("pb-1.5");
  });

  it("does not add the extra gap to a step without a subtitle", () => {
    const harness = setupAuth({ signedIn: false });
    const { container } = renderAuth(
      <AuthCard title="Check your email">
        <label htmlFor="code">Code</label>
      </AuthCard>,
      harness,
    );
    expect(headerOf(container).className).not.toContain("pb-1.5");
  });
});
