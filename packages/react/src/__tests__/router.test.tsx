import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { joinPath, matchPath, resetVirtualRouter, useRouter, type RouterOptions } from "../lib/routing";
import { renderWithProvider } from "./helpers";

afterEach(() => {
  resetVirtualRouter();
  window.history.replaceState(null, "", "/");
});

function Probe(options: RouterOptions) {
  const router = useRouter(options);
  return (
    <>
      <p data-testid="path">{router.path}</p>
      <p data-testid="match">{String(router.match("/step-two"))}</p>
      <button onClick={() => router.navigate("/step-two")}>go</button>
    </>
  );
}

describe("useRouter", () => {
  it("supports virtual routing shared between components", () => {
    renderWithProvider(<Probe routing="virtual" />);
    expect(screen.getByTestId("path").textContent).toBe("/");
    expect(screen.getByTestId("match").textContent).toBe("false");

    fireEvent.click(screen.getByText("go"));
    expect(screen.getByTestId("path").textContent).toBe("/step-two");
    expect(screen.getByTestId("match").textContent).toBe("true");
  });

  it("reads and writes path-routed steps below the base path", async () => {
    window.history.replaceState(null, "", "/sign-in/factor-one");
    renderWithProvider(<Probe routing="path" path="/sign-in" />);

    expect(screen.getByTestId("path").textContent).toBe("/factor-one");
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(window.location.pathname).toBe("/sign-in/step-two"));
    await waitFor(() => expect(screen.getByTestId("path").textContent).toBe("/step-two"));
  });

  it("uses hash routing when configured", async () => {
    window.history.replaceState(null, "", "/#/step-one");
    renderWithProvider(<Probe routing="hash" />);

    expect(screen.getByTestId("path").textContent).toBe("/step-one");
    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(window.location.hash).toBe("#/step-two"));
  });

  it("delegates navigation to the provider routerPush", async () => {
    const routerPush = vi.fn();
    window.history.replaceState(null, "", "/sign-in");
    renderWithProvider(<Probe routing="path" path="/sign-in" />, { providerProps: { routerPush } });

    fireEvent.click(screen.getByText("go"));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/sign-in/step-two"));
    expect(window.location.pathname).toBe("/sign-in");
  });

  it("matches parameterised paths", () => {
    expect(matchPath("/verify/123", "/verify/:id")).toBe(true);
    expect(matchPath("/verify", "/verify/:id")).toBe(false);
    expect(matchPath("/a/b/c", "/a/*")).toBe(true);
    expect(matchPath("/a", "/a/*")).toBe(true);
    expect(joinPath("/sign-in", "/step-two")).toBe("/sign-in/step-two");
    expect(joinPath("/", "/step-two")).toBe("/step-two");
    expect(joinPath("/sign-in", "/")).toBe("/sign-in/");
  });
});
