import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog } from "./confirm-dialog";

function renderDialog(overrides: { pending?: boolean; onOpenChange?: (open: boolean) => void } = {}) {
  const onOpenChange = overrides.onOpenChange ?? vi.fn();
  const onConfirm = vi.fn();
  render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete this user permanently?"
      confirmLabel="Delete user"
      destructive
      pending={overrides.pending}
      onConfirm={onConfirm}
    />,
  );
  return { onOpenChange, onConfirm };
}

describe("ConfirmDialog", () => {
  it("stays open on Escape while the request is pending", () => {
    const { onOpenChange } = renderDialog({ pending: true });
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes on Escape once the request has settled", () => {
    const { onOpenChange } = renderDialog({ pending: false });

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
