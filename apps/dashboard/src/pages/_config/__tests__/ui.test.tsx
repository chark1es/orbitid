import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { JsonEditor, SaveBar, SecretReveal } from "../ui";

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
});
