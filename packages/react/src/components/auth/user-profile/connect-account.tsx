import { useEffect, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Textarea,
} from "@orbitid/ui";
import { LinkIcon } from "lucide-react";
import { currentUser, reloadOrbit } from "../_shared/api";
import { ProviderIcon } from "../_shared/provider-icon";
import { useAuthRuntime } from "../_shared/w6";
import { usePortalClass } from "../_shared/appearance";

export function ConnectAccountDialog({
  open,
  provider,
  onOpenChange,
  onError,
}: {
  open: boolean;
  provider: string | null;
  onOpenChange: (open: boolean) => void;
  onError: (caught: unknown) => void;
}) {
  const portalClass = usePortalClass();
  const runtime = useAuthRuntime();
  const { t, orbit, environment } = runtime;
  const [scopes, setScopes] = useState("");
  const [busy, setBusy] = useState(false);
  const display = environment.social.find((candidate) => candidate.id === provider)?.name ?? provider ?? "";

  const connect = async () => {
    const user = currentUser(orbit);
    if (!user?.createExternalAccount || !provider) return;
    setBusy(true);
    try {
      const redirectUrl = typeof window === "undefined" ? undefined : window.location.href;
      const result = await user.createExternalAccount({
        strategy: provider.startsWith("oauth_") ? provider : `oauth_${provider}`,
        redirectUrl,
        ...(scopes.trim() ? { additionalScopes: scopes.trim().split(/\s+/) } : {}),
      });
      const redirect = extractRedirect(result);
      if (redirect) {
        if (/^https?:/i.test(redirect) && typeof window !== "undefined" && !redirect.startsWith(window.location.origin)) {
          window.location.assign(redirect);
        } else {
          runtime.navigate(redirect);
        }
        return;
      }
      onOpenChange(false);
      await reloadOrbit(orbit);
      runtime.refresh();
    } catch (caught) {
      onError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={portalClass("max-w-md")}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ProviderIcon provider={provider ?? ""} className="size-5" />
            {t("userProfile.connectedAccounts.connect")} {display}
          </DialogTitle>
          <DialogDescription>{t("userProfile.connectedAccounts.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="account-scopes">{t("userProfile.connectedAccounts.scopes")}</Label>
          <Textarea
            id="account-scopes"
            value={scopes}
            onChange={(event) => setScopes(event.target.value)}
            placeholder={t("userProfile.connectedAccounts.scopesHint")}
            rows={2}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("common.cancel")}
          </Button>
          <Button type="button" disabled={busy} onClick={() => void connect()}>
            <LinkIcon className="size-4" aria-hidden="true" />
            {t("userProfile.connectedAccounts.connect")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function extractRedirect(result: unknown): string | null {
  if (typeof result !== "object" || result === null) return null;
  const verification = Reflect.get(result, "verification");
  if (typeof verification !== "object" || verification === null) return null;
  const url = Reflect.get(verification, "external_verification_redirect_url");
  return typeof url === "string" ? url : null;
}

export function EnterpriseAccountsSection() {
  const runtime = useAuthRuntime();
  const { orbit, t } = runtime;
  const [accounts, setAccounts] = useState<unknown[]>([]);
  const user = currentUser(orbit);

  useEffect(() => {
    let cancelled = false;
    if (!user?.getEnterpriseAccounts) return;
    void user
      .getEnterpriseAccounts()
      .then((result) => {
        if (!cancelled) setAccounts(Array.isArray(result) ? result : []);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (accounts.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-orbit-section="enterprise-accounts">
      <div>
        <h2 className="text-sm font-semibold">{t("userProfile.enterpriseAccounts.title")}</h2>
        <p className="text-xs text-muted-foreground">{t("userProfile.enterpriseAccounts.description")}</p>
      </div>
      <ul className="flex flex-col divide-y rounded-md border">
        {accounts.map((account, index) => {
          const name =
            typeof account === "object" && account !== null
              ? Reflect.get(account, "enterprise_connection_name") ?? Reflect.get(account, "name")
              : null;
          return (
            <li key={index} className="flex min-w-0 items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <span className="min-w-0 truncate">{typeof name === "string" ? name : t("userProfile.enterpriseAccounts.title")}</span>
              <Badge variant="outline">{t("userProfile.connectedAccounts.connected")}</Badge>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
