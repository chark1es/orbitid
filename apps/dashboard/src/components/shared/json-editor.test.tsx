import { useState } from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { JsonEditor } from "./json-editor";

function Harness({ initial = "{}" }: { initial?: string }) {
  const [value, setValue] = useState(initial);
  return <JsonEditor id="metadata" label="Public metadata" value={value} onChange={setValue} />;
}

describe("JsonEditor", () => {
  it("shows a validation error for invalid JSON and blocks formatting", () => {
    render(<Harness />);
    const textarea = screen.getByLabelText("Public metadata");
    fireEvent.change(textarea, { target: { value: '{"plan":' } });

    const alert = screen.getByRole("alert");
    expect(alert.textContent?.length).toBeGreaterThan(0);
    expect(alert.textContent).not.toContain("Valid JSON object");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect((screen.getByRole("button", { name: "Format" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("rejects non-object JSON", () => {
    render(<Harness initial="[]" />);
    expect(screen.getByRole("alert").textContent).toContain("Expected a JSON object");
    expect((screen.getByRole("button", { name: "Format" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("formats valid JSON in place", () => {
    render(<Harness initial='{"plan":"pro","seats":3}' />);
    const textarea = screen.getByLabelText("Public metadata") as HTMLTextAreaElement;
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByText("Valid JSON object")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Format" }));
    expect(textarea.value).toBe('{\n  "plan": "pro",\n  "seats": 3\n}');
  });
});
