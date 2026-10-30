import { describe, expect, it } from "vitest";
import { screen, act } from "@testing-library/react";
import { useForm } from "react-hook-form";
import { Input } from "@orbitid/ui";
import { PasswordInput } from "../_shared/password-field";
import { Field } from "../_shared/field";
import { renderAuth, setupAuth } from "./fake-auth";

interface Values {
  email: string;
}

function Harness({ withHint }: { withHint: boolean }) {
  const form = useForm<Values>({ defaultValues: { email: "" } });
  return (
    <>
      <button type="button" onClick={() => form.setError("email", { message: "Enter your email address" })}>
        fail
      </button>
      <Field control={form.control} name="email" label="Email" description={withHint ? "We never share it" : undefined}>
        {(field) => <Input {...field} />}
      </Field>
    </>
  );
}

describe("Field", () => {
  it("links the control to its hint and error so assistive tech announces them with the field", async () => {
    renderAuth(<Harness withHint />, setupAuth({ signedIn: false }));
    const input = screen.getByLabelText("Email");
    expect(input.getAttribute("aria-invalid")).toBeNull();
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByText("We never share it").id);

    await act(async () => {
      screen.getByRole("button", { name: "fail" }).click();
    });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("Enter your email address");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const describedBy = (input.getAttribute("aria-describedby") ?? "").split(" ");
    expect(describedBy).toContain(alert.id);
    expect(describedBy).toContain(screen.getByText("We never share it").id);
  });
});

it("lets a keyboard user focus and activate the password visibility control", () => {
  renderAuth(<PasswordInput id="password" value="secret" onChange={() => undefined} />, setupAuth({ signedIn: false }));
  const toggle = screen.getByRole("button", { name: /show password/i });
  expect(toggle.tabIndex).toBe(0);
  act(() => { toggle.focus(); toggle.click(); });
  expect(document.activeElement).toBe(toggle);
  expect(document.getElementById("password")?.getAttribute("type")).toBe("text");
});
