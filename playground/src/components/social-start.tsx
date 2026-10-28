"use client";

import * as React from "react";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@orbitid/ui";
import { useSignIn } from "@orbitid/react";

export function SocialStartButton({ strategy, provider }: { strategy: string; provider: string }) {
  const { isLoaded, signIn } = useSignIn();
  const [state, setState] = React.useState<"idle" | "pending" | "error">("idle");
  const [message, setMessage] = React.useState<string | null>(null);

  async function start() {
    if (!signIn) return;
    setState("pending");
    setMessage(null);
    try {
      const origin = window.location.origin;
      await signIn.authenticateWithRedirect({
        strategy,
        redirectUrl: `${origin}/sign-in/sso-callback`,
        redirectUrlComplete: `${origin}/account`,
      });
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? `${error.message} Check the provider's client ID and secret, and that this origin is an allowed redirect origin.`
          : "The provider did not start. Check its credentials in the dashboard.",
      );
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={start}
        disabled={!isLoaded || state === "pending"}
        aria-busy={state === "pending"}
      >
        {state === "pending" ? `Starting ${provider}` : `Continue with ${provider}`}
        <ArrowUpRight aria-hidden="true" />
      </Button>
      {state === "error" && message ? (
        <p role="alert" className="max-w-[36ch] text-right text-xs text-signal">
          {message}
        </p>
      ) : null}
    </div>
  );
}
