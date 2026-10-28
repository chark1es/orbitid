import { useState } from "react";
import { toast } from "sonner";
import type { ActorTokenJSON } from "@orbitid/shared";
import { api } from "./api";
import { errorMessage } from "./errors";
import { homeUrlOf, useInstance } from "./instance";

/**
 * Creates an actor token and opens the app with it. The blank popup is opened synchronously so the
 * browser does not treat the post-request navigation as a blocked popup.
 */
export function useImpersonate() {
  const instance = useInstance();
  const [pending, setPending] = useState(false);

  async function impersonate(userId: string): Promise<void> {
    const homeUrl = homeUrlOf(instance.data);
    if (!homeUrl) {
      toast.error("Set the application home URL in Authentication settings before impersonating.");
      return;
    }
    const popup = window.open("about:blank", "orbitid-impersonate");
    setPending(true);
    try {
      const actorToken = await api<ActorTokenJSON>("POST", "/actor_tokens", { user_id: userId });
      const target =
        actorToken.url ??
        (actorToken.token ? `${homeUrl.replace(/\/+$/, "")}?__orbit_ticket=${encodeURIComponent(actorToken.token)}` : null);
      if (!target) throw new Error("The server did not return an impersonation URL or token.");
      if (popup) {
        popup.opener = null;
        popup.location.replace(target);
      } else {
        window.open(target, "_blank", "noopener,noreferrer");
      }
      toast.success("Impersonation session opened in a new tab");
    } catch (error) {
      popup?.close();
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return { impersonate, pending };
}
