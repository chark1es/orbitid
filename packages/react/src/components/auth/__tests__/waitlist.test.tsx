import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { Waitlist } from "../index";
import { renderAuth, setupAuth } from "./fake-auth";

describe("Waitlist", () => {
  it("joins the waitlist and shows the success state", async () => {
    const harness = setupAuth({ signedIn: false });
    const create = vi.fn(async () => ({ object: "waitlist_entry", id: "wle_1" }));
    harness.instance.waitlist = { create };
    renderAuth(<Waitlist signInUrl="/login" />, harness);

    fireEvent.change(await screen.findByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Join waitlist" }));

    await waitFor(() => expect(create).toHaveBeenCalledWith({ emailAddress: "ada@example.com" }));
    expect(await screen.findByText("You're on the list")).toBeTruthy();
    expect(screen.getByText(/We'll let you know at ada@example.com/)).toBeTruthy();
  });
});
