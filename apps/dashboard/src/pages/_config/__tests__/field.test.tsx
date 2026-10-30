import { expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Input, Select, SelectTrigger, SelectValue } from "@orbitid/ui";
import { Field, SecretInput } from "../ui";

it("connects generated labels, required state, hints and errors without losing caller hints", () => {
  const { rerender } = render(<><p id="existing">Existing hint</p><Field label="Name" required description="Name hint" error="Name is missing"><Input aria-describedby="existing" /></Field></>);
  const input = screen.getByRole("textbox", { name: /Name/ });
  expect(input.getAttribute("aria-required")).toBe("true");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  const descriptions = input.getAttribute("aria-describedby")!.split(" ");
  expect(descriptions.map((id) => document.getElementById(id)?.textContent)).toEqual(["Existing hint", "Name hint", "Name is missing"]);
  expect(screen.getByRole("alert").textContent).toBe("Name is missing");
  rerender(<Field label="Name" description="Name hint"><Input /></Field>);
  expect(screen.getByRole("textbox", { name: "Name" }).hasAttribute("aria-invalid")).toBe(false);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("associates a nested select trigger rather than putting ARIA on its wrapper", () => {
  render(<Field label="Provider" htmlFor="provider" required error="Choose a provider"><Select><div><SelectTrigger id="provider"><SelectValue /></SelectTrigger></div></Select></Field>);
  const trigger = screen.getByRole("combobox", { name: /Provider/ });
  expect(trigger.getAttribute("aria-invalid")).toBe("true");
  expect(trigger.getAttribute("aria-required")).toBe("true");
  expect(document.getElementById(trigger.getAttribute("aria-describedby")!)?.textContent).toBe("Choose a provider");
});

it("carries write-only secret field hints and required state to the actual input", () => {
  render(<SecretInput id="secret" label="Client secret" value="" configured={false} required onChange={() => undefined} />);
  const input = screen.getByLabelText(/Client secret/);
  expect(input.getAttribute("aria-required")).toBe("true");
  expect(document.getElementById(input.getAttribute("aria-describedby")!)?.textContent).toContain("No value is stored");
});
