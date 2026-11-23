import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  cn,
} from "@orbitid/ui";
import type { RoleOption } from "./types";
import { usePortalClass } from "../../auth/_shared/appearance";

export interface RoleSelectProps {
  roles: RoleOption[];
  value: string;
  onChange: (role: string) => void;
  disabled?: boolean;
  /** Visible label (rendered above the trigger); omit inside table cells. */
  label?: string;
  /** Accessible name for the trigger (required when `label` is omitted). */
  ariaLabel?: string;
  id?: string;
  size?: "sm" | "default";
  className?: string;
}

/** Role picker shared by member rows, invite dialogs and the create-organization flow. */
export function RoleSelect({
  roles,
  value,
  onChange,
  disabled,
  label,
  ariaLabel,
  id,
  size = "sm",
  className,
}: RoleSelectProps) {
  const portalClass = usePortalClass();
  const options = roles.length > 0 ? roles : [{ key: value, name: value }];
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label ? (
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
      ) : null}
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          size={size}
          aria-label={ariaLabel ?? label}
          className="w-full min-w-[7rem]"
        >
          <SelectValue placeholder={value} />
        </SelectTrigger>
        <SelectContent className={portalClass()}>
          {options.map((role) => (
            <SelectItem key={role.key} value={role.key}>
              {role.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
