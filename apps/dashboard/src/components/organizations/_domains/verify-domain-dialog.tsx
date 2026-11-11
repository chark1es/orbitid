import { useState } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
} from "@orbitid/ui";
import { OVERLAY_WIDTH } from "../../shared/overlay-sizes";
import { toast } from "sonner";
import type { OrganizationDomainJSON, OrganizationJSON } from "@orbitid/shared";
import { api } from "../../../lib/api";
import { errorMessage } from "../../../lib/errors";

/** Domain ownership verification: send a code to an address on the domain, then check that code. */
export function VerifyDomainDialog({
  org,
  domain,
  onOpenChange,
  onVerified,
}: {
  org: OrganizationJSON;
  domain: OrganizationDomainJSON | null;
  onOpenChange: (open: boolean) => void;
  onVerified: () => void;
}) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const suffix = domain ? `@${domain.name.toLowerCase()}` : "";
  const emailValid = email.trim().length > 0 && email.trim().toLowerCase().endsWith(suffix);

  function reset() {
    setStep("email");
    setEmail("");
    setCode("");
    setSentTo("");
    setError(null);
  }

  function changeOpen(open: boolean) {
    if (!open) reset();
    onOpenChange(open);
  }

  async function sendCode() {
    if (!domain || !emailValid) return;
    setPending(true);
    setError(null);
    try {
      await api("POST", `/organizations/${org.id}/domains/${domain.id}/prepare_affiliation_verification`, {
        affiliation_email_address: email.trim(),
      });
      setSentTo(email.trim());
      setStep("code");
      toast.success("Verification code sent");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  async function verify() {
    if (!domain || !code.trim()) return;
    setPending(true);
    setError(null);
    try {
      await api("POST", `/organizations/${org.id}/domains/${domain.id}/attempt_affiliation_verification`, {
        code: code.trim(),
      });
      toast.success(`${domain.name} verified`);
      reset();
      onVerified();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={domain !== null} onOpenChange={changeOpen}>
      <DialogContent className={OVERLAY_WIDTH.form}>
        <DialogHeader>
          <DialogTitle>Verify {domain?.name ?? "domain"}</DialogTitle>
          <DialogDescription>
            {step === "email"
              ? `Send a code to a mailbox on ${domain?.name ?? "this domain"}. Receiving it proves the domain belongs to ${org.name}.`
              : `Enter the code sent to ${sentTo}. It expires shortly, and a new request replaces it.`}
          </DialogDescription>
        </DialogHeader>

        {step === "email" ? (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="affiliation-email">Affiliation email address</Label>
              <Input
                id="affiliation-email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder={`you${suffix}`}
                aria-invalid={email.length > 0 && !emailValid ? true : undefined}
                autoFocus
              />
              <p className="text-xs leading-5 text-muted-foreground">The address must end with {suffix || "the domain name"}.</p>
            </div>
            {error ? (
              <p role="alert" className="rounded-[3px] border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => changeOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => void sendCode()} disabled={pending || !emailValid}>
                Send code
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="affiliation-code">Verification code</Label>
              <Input
                id="affiliation-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoFocus
              />
            </div>
            {error ? (
              <p role="alert" className="rounded-[3px] border border-signal/40 bg-signal/10 px-3 py-2 text-sm text-signal">
                {error}
              </p>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("email")} disabled={pending}>
                Back
              </Button>
              <Button onClick={() => void verify()} disabled={pending || !code.trim()}>
                Verify domain
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
