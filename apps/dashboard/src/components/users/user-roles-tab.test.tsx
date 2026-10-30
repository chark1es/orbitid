import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { UserJSON } from "@orbitid/shared";
import { UserRolesTab } from "./user-roles-tab";
import { mockApi, renderPage } from "../../pages/_config/__tests__/harness";

it("assigns instance roles through the dedicated endpoint and never offers organization roles", async () => {
  const calls = mockApi({ handle: (call) => {
    if (call.url.includes("/v1/roles") && call.method === "GET") return Response.json({ data: [
      { id: "role_support", key: "app:support", name: "Support" },
      { id: "role_admin", key: "org:admin", name: "Organization admin" },
    ], total_count: 2 });
  } });
  renderPage(<UserRolesTab user={{ id: "user_1", roles: ["app:existing"] } as UserJSON} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: /Support/ }));
  expect(screen.queryByRole("checkbox", { name: /Organization admin/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Save roles" }));
  await waitFor(() => expect(calls.find((call) => call.method === "PUT")).toMatchObject({ url: expect.stringContaining("/v1/users/user_1/roles"), body: { roles: ["app:existing", "app:support"] } }));
});
