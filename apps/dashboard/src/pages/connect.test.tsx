import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import Page from "./connect";
import { clipboardStub, instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

describe("connect your app", () => {
  it("shows the instance keys, URL and database from the running server", async () => {
    mockApi({ instance: instanceBody((settings) => { settings.application.homeUrl = "https://app.example.com"; }) });
    renderPage(<Page />);

    expect(await screen.findByText("pk_test_demo")).toBeTruthy();
    expect(screen.getAllByText("http://localhost:4000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Postgres").length).toBeGreaterThan(0);
    expect(screen.getByText(/^sk_test_••••/)).toBeTruthy();
  });

  it("defaults to the Next.js blocks with public and secret headings", async () => {
    mockApi();
    renderPage(<Page />);

    expect(await screen.findByRole("heading", { name: "Website · browser (public)" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Website · backend (secret)" })).toBeTruthy();
    expect(screen.getByText("bun add @orbitid/nextjs")).toBeTruthy();
    expect(screen.getByText(/Paste into \.env\.local/)).toBeTruthy();
    expect(screen.getByText(/Safe to ship to browsers/)).toBeTruthy();
    expect(screen.getByText(/never in a bundle/)).toBeTruthy();
  });

  it("masks the secret by default and reveals it on demand", async () => {
    mockApi();
    renderPage(<Page />);

    await screen.findByRole("heading", { name: "Website · backend (secret)" });
    expect(screen.queryByText(/ORBITID_SECRET_KEY=sk_test_dashboard_session/)).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: /Reveal secret/ })[0]!);
    expect(screen.getByText(/ORBITID_SECRET_KEY=sk_test_dashboard_session/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Hide secret/ })[0]!);
    expect(screen.queryByText(/ORBITID_SECRET_KEY=sk_test_dashboard_session/)).toBeNull();
  });

  it("copies a block with the real value even while it is masked", async () => {
    const written = clipboardStub();
    mockApi();
    renderPage(<Page />);

    await screen.findByRole("heading", { name: "Website · backend (secret)" });
    const panel = screen.getByRole("tabpanel");
    const copyButtons = within(panel).getAllByRole("button", { name: "Copy" });
    // First block is the public one, second is the backend.
    fireEvent.click(copyButtons[1]!);

    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(written.at(-1)).toContain("# Website · backend (secret)");
    expect(written.at(-1)).toContain("ORBITID_SECRET_KEY=sk_test_dashboard_session");
    expect(written.at(-1)).toContain("ORBITID_API_URL=http://localhost:4000");
  });

  it("copies all blocks for the current framework", async () => {
    const written = clipboardStub();
    mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Copy all/ }));
    await waitFor(() => expect(written.length).toBeGreaterThan(0));
    expect(written.at(-1)).toContain("NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=pk_test_demo");
    expect(written.at(-1)).toContain("ORBITID_SECRET_KEY=sk_test_dashboard_session");
  });

  it("switches variable names with the framework tabs", async () => {
    mockApi();
    renderPage(<Page />);

    fireEvent.mouseDown(await screen.findByRole("tab", { name: "React + backend" }));
    expect(await screen.findByText(/VITE_ORBITID_PUBLISHABLE_KEY=pk_test_demo/)).toBeTruthy();
    expect(screen.getByText("bun add @orbitid/react @orbitid/backend")).toBeTruthy();

    fireEvent.mouseDown(screen.getByRole("tab", { name: "Plain Node script" }));
    expect(await screen.findByText(/bun add @orbitid\/node/)).toBeTruthy();
    expect(screen.getAllByText(/list-users\.ts/).length).toBeGreaterThan(0);
  });

  it("summarises the server without naming the encryption key", async () => {
    mockApi();
    renderPage(<Page />);

    expect(await screen.findByRole("heading", { name: "Server (this instance)" })).toBeTruthy();
    expect(screen.getByText(/docs\/ENVIRONMENT\.md/)).toBeTruthy();
    expect(screen.getByText(/docs\/SELF_HOSTING\.md/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open the API reference/ }).getAttribute("href")).toBe(
      "http://localhost:4000/docs",
    );
    expect(document.body.textContent).not.toMatch(/ORBITID_ENCRYPTION_KEY=/);
  });

  it("checks the setup against health and the environment endpoint", async () => {
    const calls = mockApi();
    renderPage(<Page />);

    expect(await screen.findByText(/Server reachable/)).toBeTruthy();
    expect(await screen.findByText(/accepts email code, password/)).toBeTruthy();
    expect(screen.getByText(/Sign-in methods published/)).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith("/health"))).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/v1/client/environment"))).toBe(true);
  });

  it("says what broke when the server is unreachable", async () => {
    mockApi({
      handle: (call) =>
        call.url.endsWith("/health") || call.url.includes("/v1/client/environment")
          ? new Response(JSON.stringify({ errors: [{ code: "unreachable" }] }), { status: 503 })
          : undefined,
      instance: instanceBody(),
    });
    renderPage(<Page />);

    expect(await screen.findByText(/Server reachable/)).toBeTruthy();
    expect(await screen.findByText(/GET http:\/\/localhost:4000\/health failed/)).toBeTruthy();
    expect(screen.getByText(/Sign-in methods published/)).toBeTruthy();
  });

  it("offers placeholders when the session has no secret key", async () => {
    mockApi();
    renderPage(<Page />, { secretKey: null });

    expect(await screen.findByText("No secret key in this session")).toBeTruthy();
    expect(screen.getByText(/ORBITID_SECRET_KEY=sk_test_…/)).toBeTruthy();
    expect(screen.getAllByText("Not in this session").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /Copy placeholders/ })).toBeTruthy();
  });
});
