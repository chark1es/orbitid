import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { JwtTemplateJSON } from "@orbitid/shared";
import JwtTemplatesPage from "./jwt-templates";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const TEMPLATE = {
  id: "jwt_1",
  name: "hasura",
  claims: { role: "{{org.role}}" },
  lifetime: 60,
  allowed_clock_skew: 5,
  signing_algorithm: "RS256",
  custom_signing_key: false,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
} as unknown as JwtTemplateJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

describe("JWT templates page", () => {
  it("shows the loading skeleton", () => {
    pendingApi();
    renderPage(<JwtTemplatesPage />);
    expect(screen.getByLabelText("Loading rows")).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi();
    renderPage(<JwtTemplatesPage />);
    expect(await screen.findByText("No JWT templates")).toBeTruthy();
  });

  it("renders every template across pages", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (!call.url.includes("/v1/jwt_templates")) return undefined;
        if (call.url.includes("offset=0")) {
          return list([TEMPLATE], 2);
        }
        return list([{ ...TEMPLATE, id: "jwt_2", name: "second" }], 2);
      },
    });
    renderPage(<JwtTemplatesPage />);

    expect(await screen.findByText("hasura")).toBeTruthy();
    expect(await screen.findByText("second")).toBeTruthy();
    expect(calls.some((call) => call.url.includes("offset=1"))).toBe(true);
  });

  it("shows the list error", async () => {
    mockApi({
      handle: (call) =>
        call.url.includes("/v1/jwt_templates")
          ? json({ errors: [{ long_message: "Templates unavailable" }] }, 500)
          : undefined,
    });
    renderPage(<JwtTemplatesPage />);
    expect(await screen.findByText(/Templates unavailable/)).toBeTruthy();
  });

  it("does not greet a new template with a validation list", async () => {
    mockApi({
      handle: (call) => (call.url.includes("/v1/jwt_templates") ? list([]) : undefined),
    });
    renderPage(<JwtTemplatesPage />);
    await screen.findByText("No JWT templates");

    fireEvent.click(screen.getAllByRole("button", { name: /New template/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText("Fix these before saving")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: /Create template/ }));
    expect(await within(sheet).findByText("Fix these before saving")).toBeTruthy();
    expect(within(sheet).getByText("Template name is required.")).toBeTruthy();
  });

  it("creates a template with its claims and lifetime", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/jwt_templates")) return json(TEMPLATE);
        if (call.url.includes("/v1/jwt_templates")) return list([]);
        return undefined;
      },
    });
    renderPage(<JwtTemplatesPage />);
    await screen.findByText("No JWT templates");

    fireEvent.click(screen.getAllByRole("button", { name: /New template/ })[0]!);
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Name/), { target: { value: "hasura" } });
    fireEvent.change(within(sheet).getByLabelText("Template claims"), { target: { value: '{"role":"{{org.role}}"}' } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Create template/ }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/jwt_templates"))?.body).toEqual({
        name: "hasura",
        claims: { role: "{{org.role}}" },
        lifetime: 60,
        allowed_clock_skew: 5,
        signing_algorithm: "RS256",
        custom_signing_key: false,
      });
    });
  });

  it("edits a template", async () => {
    const calls = mockApi({
      handle: (call) => {
        if (call.method === "PATCH" && call.url.endsWith("/v1/jwt_templates/jwt_1")) return json(TEMPLATE);
        if (call.url.includes("/v1/jwt_templates")) return list([TEMPLATE]);
        return undefined;
      },
    });
    renderPage(<JwtTemplatesPage />);
    await screen.findByText("hasura");

    fireEvent.click(screen.getByRole("button", { name: "Edit hasura" }));
    const sheet = await screen.findByRole("dialog");
    fireEvent.change(within(sheet).getByLabelText(/Lifetime/), { target: { value: "120" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save changes/ }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ name: "hasura", lifetime: 120 });
    });
  });

  it("deletes a template only after confirmation", async () => {
    const calls = mockApi({
      handle: (call) => (call.url.includes("/v1/jwt_templates") ? list([TEMPLATE]) : undefined),
    });
    renderPage(<JwtTemplatesPage />);
    await screen.findByText("hasura");

    fireEvent.click(screen.getByRole("button", { name: "Delete hasura" }));
    expect(screen.getByText("Delete JWT template?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete template" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/jwt_templates/jwt_1"))).toBe(true);
    });
  });
});
