import { describe, expect, it } from "vitest"
import { render } from "@testing-library/react"
import { ElementSlotProvider, mergeElementSlot, themingClasses, type ElementSlotResolver } from "../../lib/element-slots"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "../ui/input-otp"
import { OrbitMark } from "../orbit-mark"

const unstyled: ElementSlotResolver = (keys) => ({ className: keys.map((key) => `orbitid-${key}`).join(" "), unstyled: true })

describe("element slots", () => {
  it("keep the scheme and scope classes when an element is unstyled", () => {
    const merged = mergeElementSlot(unstyled, ["modalContent"], "fixed rounded-xl bg-popover", {
      className: "dark orbitid-scope-r1 orbitid-component orbitid-motion-off max-w-md",
    })
    expect(merged.className.split(" ").sort()).toEqual(
      ["dark", "orbitid-component", "orbitid-modalContent", "orbitid-motion-off", "orbitid-scope-r1"].sort(),
    )
  })

  it("pick the theming classes out of a class list", () => {
    expect(themingClasses("light p-4", "orbitid-scope-x text-sm orbitid-component")).toBe("light orbitid-scope-x orbitid-component")
  })

  it("leave a part with no key untouched", () => {
    expect(mergeElementSlot(unstyled, [], "size-4", { className: "mine" })).toEqual({ className: "size-4 mine", style: undefined })
  })

  it("let a caller's explicit key restyle the OTP group, slots and the mark", () => {
    const resolver: ElementSlotResolver = (keys) =>
      keys.includes("otpCodeFieldInput") || keys.includes("logoImage")
        ? { className: "mine", unstyled: true }
        : { className: "group-class", style: { gap: "9px" } }
    const { container } = render(
      <ElementSlotProvider value={resolver}>
        <InputOTP maxLength={2}>
          <InputOTPGroup data-orbitid-element="formFieldInputGroup">
            <InputOTPSlot index={0} data-orbitid-element="otpCodeFieldInput" />
          </InputOTPGroup>
        </InputOTP>
        <OrbitMark className="size-9" data-orbitid-element="logoImage" />
      </ElementSlotProvider>,
    )
    const group = container.querySelector('[data-slot="input-otp-group"]') as HTMLElement
    expect(group.style.gap).toBe("9px")
    expect(group.className).toContain("group-class")
    expect(container.querySelector('[data-slot="input-otp-slot"]')?.className).toBe("mine")
    expect(container.querySelector("svg")?.getAttribute("class")).toBe("mine")
  })
})
