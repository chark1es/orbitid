import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog, DetailSheet, JsonEditor, Notice, SaveBar, SecretInput, SecretReveal, StatusBadge } from "../ui";

describe("SaveBar", () => {
  it("is hidden when there is nothing to save", () => {
    render(<SaveBar dirty={false} saving={false} onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.queryByText("Save changes")).toBeNull();
  });

  it("saves and discards dirty settings", () => {
    const onSave = vi.fn();
    const onDiscard = vi.fn();
    render(<SaveBar dirty saving={false} onSave={onSave} onDiscard={onDiscard} />);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));
    fireEvent.click(screen.getByRole("button", { name: /discard/i }));
    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });

  it("disables saving while a validation error is present", () => {
    render(<SaveBar dirty saving={false} disabled onSave={vi.fn()} onDiscard={vi.fn()} />);
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
  });

  it("lists validation problems with the fix and stays visible when clean", () => {
    render(
      <SaveBar
        dirty={false}
        saving={false}
        errors={["Password minimum length must be at least 1."]}
        onSave={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText("One setting needs attention")).toBeTruthy();
    expect(screen.getByText("Password minimum length must be at least 1.")).toBeTruthy();
    expect(screen.getByText("Fix the listed fields to enable saving.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /discard/i }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed save with the next step", () => {
    render(
      <SaveBar dirty saving={false} error="connect ECONNREFUSED" onSave={vi.fn()} onDiscard={vi.fn()} />,
    );
    expect(screen.getByText(/Save failed: connect ECONNREFUSED/)).toBeTruthy();
    expect(screen.getByText(/Check the server log, then save again/)).toBeTruthy();
  });
});

describe("StatusBadge", () => {
  it("always carries the status word next to the dot", () => {
    const { rerender, container } = render(<StatusBadge status="active" />);
    expect(screen.getByText("active")).toBeTruthy();
    expect(container.querySelector(".bg-go")).toBeTruthy();
    rerender(<StatusBadge status="failed" />);
    expect(screen.getByText("failed")).toBeTruthy();
    expect(container.querySelector(".bg-signal")).toBeTruthy();
    rerender(<StatusBadge status="revoked" />);
    expect(screen.getByText("revoked")).toBeTruthy();
    expect(container.querySelector(".bg-signal")).toBeTruthy();
  });
});

describe("JsonEditor", () => {
  it("reports edits and surfaces validation errors", () => {
    const onChange = vi.fn();
    const { rerender } = render(<JsonEditor value="{}" onChange={onChange} aria-label="claims" />);
    fireEvent.change(screen.getByLabelText("claims"), { target: { value: '{"role":"admin"}' } });
    expect(onChange).toHaveBeenCalledWith('{"role":"admin"}');
    rerender(<JsonEditor value="{}" onChange={onChange} error="Expected a JSON object." aria-label="claims" />);
    expect(screen.getByText("Expected a JSON object.")).toBeTruthy();
  });
});

describe("SecretReveal", () => {
  it("masks a secret until revealed and supports an unconfigured state", () => {
    const { rerender } = render(<SecretReveal value="super-secret-value" />);
    expect(screen.queryByText("super-secret-value")).toBeNull();
    expect(screen.getByText("••••••••••••")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /reveal secret/i }));
    expect(screen.getByText("super-secret-value")).toBeTruthy();
    rerender(<SecretReveal value="" emptyLabel="No secret yet" />);
    expect(screen.getByText("No secret yet")).toBeTruthy();
  });

  it("shows a plain warning under a revealed secret", () => {
    render(<SecretReveal value="one-time" warning="Copy it now. It is not shown again." />);
    expect(screen.getByText("Copy it now. It is not shown again.")).toBeTruthy();
  });
});

describe("DetailSheet", () => {
  it("renders form content with its title and closes from the footer", () => {
    const onOpenChange = vi.fn();
    render(
      <DetailSheet open onOpenChange={onOpenChange} title="Add endpoint" description="Events are signed." footer={<button type="button">Done</button>}>
        <label htmlFor="sheet-field">URL</label>
        <input id="sheet-field" />
      </DetailSheet>,
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText("Add endpoint")).toBeTruthy();
    expect(screen.getByLabelText("URL")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("ConfirmDialog", () => {
  it("names the destructive action and runs it only on confirm", () => {
    const onConfirm = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete endpoint?"
        description="Deliveries stop immediately."
        confirmLabel="Delete endpoint"
        destructive
        onConfirm={onConfirm}
      />,
    );
    expect(screen.getByText("Delete endpoint?")).toBeTruthy();
    expect(screen.getByText("Deliveries stop immediately.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete endpoint" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("SecretInput", () => {
  it("starts blank with a Set mark so a stored secret is never resubmitted", () => {
    const onChange = vi.fn();
    render(<SecretInput id="s" label="API key" value="" onChange={onChange} configured />);
    const input = screen.getByLabelText(/API key/) as HTMLInputElement;
    expect(input.value).toBe("");
    expect(input.type).toBe("password");
    expect(input.placeholder).toMatch(/leave blank to keep/i);
    expect(screen.getByText("Set")).toBeTruthy();
    fireEvent.change(input, { target: { value: "re_new" } });
    expect(onChange).toHaveBeenCalledWith("re_new");
  });

  it("says Not set when nothing is stored", () => {
    render(<SecretInput id="s2" label="Token" value="" onChange={vi.fn()} configured={false} />);
    expect(screen.getByText("Not set")).toBeTruthy();
  });
});

describe("Notice", () => {
  it("carries a worded title and lists the consequence", () => {
    render(
      <Notice tone="caution" title="Email is printed to the server log" role="alert">
        <p>Codes appear in plain text.</p>
      </Notice>,
    );
    expect(screen.getByRole("alert").textContent).toContain("Email is printed to the server log");
    expect(screen.getByText("Codes appear in plain text.")).toBeTruthy();
  });
});
