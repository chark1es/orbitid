// @vitest-environment jsdom
import * as React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SeedManager } from "./seed-manager";

vi.mock("@/app/seed/actions", () => ({
  createTestUsers: vi.fn(async () => ({ ok: true, message: "Created" })),
  deleteAllPlaygroundUsers: vi.fn(async () => ({ ok: true, message: "Deleted" })),
  deletePlaygroundUser: vi.fn(async () => ({ ok: true, message: "Deleted" })),
}));
afterEach(cleanup);

it("keeps seeded-user management without a sign-in-as or ticket action", () => {
  render(<SeedManager users={[{ id: "user_1", email: "ada@playground.test", firstName: "Ada", lastName: "Lovelace", createdAt: 0 }]} />);
  expect(screen.getByRole("button", { name: "Delete ada@playground.test" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: /sign.in|creating link/i })).toBeNull();
  expect(screen.queryByRole("link", { name: /sign.in as/i })).toBeNull();
});
