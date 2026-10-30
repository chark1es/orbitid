import { Separator } from "@orbitid/ui";
import { useAuthRuntime } from "../../_shared/w6";
import type { SignUpProps } from "../../_shared/types";
import type { SignUpFlow } from "../flow";

export interface SignUpStepProps {
  flow: SignUpFlow;
  props: SignUpProps;
}

export interface StartFormValues {
  emailAddress: string;
  phoneNumber: string;
  username: string;
  firstName: string;
  lastName: string;
  legalAccepted: boolean;
}

export function Divider() {
  const { t } = useAuthRuntime();
  return (
    <div className="flex items-center gap-3" role="separator">
      <Separator className="flex-1" />
      <span className="text-xs text-muted-foreground">{t("common.or")}</span>
      <Separator className="flex-1" />
    </div>
  );
}

export function LegalConsent() {
  const { t, environment } = useAuthRuntime();
  const terms = environment.app.termsUrl;
  const privacy = environment.app.privacyUrl;
  return (
    <span className="text-sm text-muted-foreground">
      {terms || privacy ? (
        <>
          {t("signUp.start.legalConsentPrefix")}{" "}
          {terms ? (
            <a href={terms} className="font-medium text-foreground underline underline-offset-4" rel="noreferrer">
              {t("footer.terms")}
            </a>
          ) : (
            t("footer.terms")
          )}{" "}
          {t("signUp.start.legalConsentConjunction")}{" "}
          {privacy ? (
            <a href={privacy} className="font-medium text-foreground underline underline-offset-4" rel="noreferrer">
              {t("footer.privacy")}
            </a>
          ) : (
            t("footer.privacy")
          )}
          .
        </>
      ) : (
        t("signUp.start.legalConsentPlain")
      )}
    </span>
  );
}
