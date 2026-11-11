import { useState } from "react";
import { useForm } from "react-hook-form";
import { Button, Input, cn } from "@orbitid/ui";
import { useAuthRuntime, isRecord } from "./_shared/w6";
import { apiRequest, errorMessage } from "./_shared/api";
import { AuthAppearanceScope, useElementClasses } from "./_shared/appearance";
import { AuthCard } from "./_shared/auth-card";
import { Field } from "./_shared/field";
import { FormError } from "./_shared/form-error";
import type { WaitlistProps } from "./_shared/types";

interface WaitlistForm {
  emailAddress: string;
}

async function joinWaitlist(orbit: ReturnType<typeof useAuthRuntime>["orbit"], emailAddress: string): Promise<void> {
  const waitlist = orbit.waitlist;
  if (isRecord(waitlist) && typeof waitlist.create === "function") {
    await (waitlist.create as (params: { emailAddress: string }) => Promise<unknown>).call(waitlist, {
      emailAddress,
    });
    return;
  }
  await apiRequest(orbit, "/v1/client/waitlist", { method: "POST", json: { email_address: emailAddress } });
}

function WaitlistInner({ afterJoinWaitlistUrl, signInUrl }: WaitlistProps) {
  const runtime = useAuthRuntime();
  const { environment, t, navigate, orbit } = runtime;
  const { el } = useElementClasses();
  const [joinedEmail, setJoinedEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const form = useForm<WaitlistForm>({ defaultValues: { emailAddress: "" }, mode: "onSubmit" });

  const submit = form.handleSubmit(async (values) => {
    const emailAddress = values.emailAddress.trim();
    setBusy(true);
    setError(null);
    try {
      await joinWaitlist(orbit, emailAddress);
      setJoinedEmail(emailAddress);
    } catch (caught) {
      setError(errorMessage(t, caught));
    } finally {
      setBusy(false);
    }
  });

  if (joinedEmail) {
    return (
      <div className="flex w-full items-center justify-center px-4 py-6">
        <AuthCard
          title={t("waitlist.successTitle")}
          subtitle={t("waitlist.successMessage", { email: joinedEmail })}
        >
          {afterJoinWaitlistUrl ? (
            <Button type="button" className="w-full" onClick={() => navigate(afterJoinWaitlistUrl)}>
              {t("waitlist.afterJoinLink")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="link"
            className="mx-auto h-auto min-h-6 px-0 py-1"
            onClick={() => navigate(signInUrl ?? "/sign-in")}
          >
            {t("waitlist.backToSignIn")}
          </Button>
        </AuthCard>
      </div>
    );
  }

  return (
    <div className="flex w-full items-center justify-center px-4 py-6">
      <AuthCard
        title={t("waitlist.title")}
        subtitle={t("waitlist.subtitle", { applicationName: environment.app.name })}
      >
        <FormError message={error} />
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field control={form.control} name="emailAddress" label={t("waitlist.emailLabel")} required>
            {(field) => (
              <Input
                {...field}
                type="email"
                autoComplete="email"
                placeholder={t("formFieldPlaceholder__emailAddress")}
                autoFocus
                disabled={busy}
                className={cn(el("formFieldInput"))}
              />
            )}
          </Field>
          <Button type="submit" disabled={busy} className={cn("w-full", el("formButtonPrimary"))}>
            {t("waitlist.action")}
          </Button>
        </form>
        <Button
          type="button"
          variant="link"
          className="mx-auto h-auto min-h-6 px-0 py-1"
          onClick={() => navigate(signInUrl ?? "/sign-in")}
        >
          {t("waitlist.backToSignIn")}
        </Button>
      </AuthCard>
    </div>
  );
}

export function Waitlist(props: WaitlistProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <WaitlistInner {...props} />
    </AuthAppearanceScope>
  );
}
