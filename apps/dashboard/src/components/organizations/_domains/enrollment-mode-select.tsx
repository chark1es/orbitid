import { useState } from "react";
import { toast } from "sonner";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import type { OrganizationDomainJSON } from "@orbitid/shared";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

export const ENROLLMENT_MODES = [
  { value: "manual_invitation", label: "Manual invitation" },
  { value: "automatic_invitation", label: "Automatic invitation" },
  { value: "automatic_suggestion", label: "Automatic suggestion" },
] as const;

type EnrollmentMode = (typeof ENROLLMENT_MODES)[number]["value"];

/** Per-domain enrollment mode. A change is saved immediately (PATCH) and the row refetches on success. */
export function EnrollmentModeSelect({
  orgId,
  domain,
  onChanged,
}: {
  orgId: string;
  domain: OrganizationDomainJSON;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<EnrollmentMode>(domain.enrollment_mode);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function change(next: string) {
    if (next === domain.enrollment_mode) return;
    setMode(next as EnrollmentMode);
    setPending(true);
    setError(null);
    try {
      await api("PATCH", `/organizations/${orgId}/domains/${domain.id}`, { enrollment_mode: next });
      toast.success("Enrollment mode updated");
      onChanged();
    } catch (cause) {
      setMode(domain.enrollment_mode);
      setError(errorMessage(cause));
      toast.error(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="space-y-1">
      <Select value={mode} onValueChange={(value) => void change(value)} disabled={pending}>
        <SelectTrigger size="sm" className="w-full max-w-[190px]" aria-label={`Enrollment mode for ${domain.name}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {ENROLLMENT_MODES.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? (
        <p role="alert" className="max-w-[190px] text-xs leading-5 text-signal">
          {error}
        </p>
      ) : null}
    </div>
  );
}
