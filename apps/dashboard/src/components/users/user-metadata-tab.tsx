import { useState } from "react";
import { toast } from "sonner";
import type { UserJSON } from "@orbitid/shared";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { MetadataEditors } from "../shared/metadata-editors";

export function UserMetadataTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [pending, setPending] = useState(false);

  async function save(patch: Record<string, Record<string, unknown>>) {
    setPending(true);
    try {
      await api("PATCH", `/users/${user.id}/metadata`, patch);
      toast.success("Metadata saved");
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <MetadataEditors
      title="User metadata"
      description="Deep-merged server-side: nested objects are preserved, `null` removes a key. Private metadata never reaches the Frontend API."
      pending={pending}
      fields={[
        {
          key: "public_metadata",
          label: "Public metadata",
          description: "Sent to clients and embedded in session tokens.",
          value: user.public_metadata,
        },
        {
          key: "private_metadata",
          label: "Private metadata",
          description: "Backend API only.",
          value: user.private_metadata,
        },
        {
          key: "unsafe_metadata",
          label: "Unsafe metadata",
          description: "Writable by the user from the client SDK.",
          value: user.unsafe_metadata,
        },
      ]}
      onSubmit={(patch) => void save(patch)}
    />
  );
}
