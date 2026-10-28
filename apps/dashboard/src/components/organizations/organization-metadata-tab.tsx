import { useState } from "react";
import { toast } from "sonner";
import type { OrganizationJSON } from "@orbitid/shared";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { MetadataEditors } from "../shared/metadata-editors";

export function OrganizationMetadataTab({ org, onChanged }: { org: OrganizationJSON; onChanged: () => void }) {
  const [pending, setPending] = useState(false);

  async function save(patch: Record<string, Record<string, unknown>>) {
    setPending(true);
    try {
      await api("PATCH", `/organizations/${org.id}`, patch);
      toast.success("Metadata saved");
      onChanged();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <MetadataEditors
      title="Organization metadata"
      description="Deep-merged server-side. Public metadata is visible to members; private metadata stays in the Backend API."
      pending={pending}
      fields={[
        {
          key: "public_metadata",
          label: "Public metadata",
          description: "Exposed to members and included in the org claim.",
          value: org.public_metadata,
        },
        {
          key: "private_metadata",
          label: "Private metadata",
          description: "Backend API only.",
          value: org.private_metadata,
        },
      ]}
      onSubmit={(patch) => void save(patch)}
    />
  );
}
