import { useMemo, useState } from "react";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orbitid/ui";
import { CopyIcon, KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import type { ApiKeyJSON } from "@orbitid/shared";
import { useLocalizations } from "../../localization";
import { useOrbitID, usePagedResource } from "../../hooks";
import type { ApiKeyResource } from "../../provider";
import { ConfirmDialog } from "./_shared/ConfirmDialog";
import { EmptyState, ErrorBanner, LoadingRows, PaginationBar } from "./_shared/Feedback";
import { OrgRoot } from "./_shared/OrgRoot";
import { createApiKey, listApiKeys, revokeApiKey } from "./_shared/fapi";
import {
  useAsyncAction,
  useClipboard,
  useOrgErrorText,
  useOrgScope,
  usePaginatedTable,
} from "./_shared/hooks";
import { formatDate, isApiKeyExpired } from "./_shared/utils";
import type { CommonOrgProps } from "./_shared/types";
import { usePortalClass } from "../auth/_shared/appearance";

export interface APIKeysProps extends CommonOrgProps {
  /** Whose keys are managed: the signed-in user or the active organization. */
  type?: "user" | "organization";
  /** Rows per page. */
  perPage?: number;
  /** Show the optional description column/field. */
  showDescription?: boolean;
}

type ExpirationChoice = "never" | "30" | "90" | "custom";

interface ApiKeyRow {
  id: string;
  name: string;
  description: string | null;
  prefix: string;
  secret?: string;
  revoked: boolean;
  expiration: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  /** SDK resource method (`POST /api_keys/:id/revoke`); absent for Frontend API rows. */
  revoke?: () => Promise<void>;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const rowFromJson = (key: ApiKeyJSON): ApiKeyRow => ({
  id: key.id,
  name: key.name,
  description: key.description,
  prefix: key.prefix,
  secret: key.secret,
  revoked: key.revoked,
  expiration: key.expiration,
  lastUsedAt: key.last_used_at,
  createdAt: key.created_at,
});

const rowFromResource = (key: ApiKeyResource): ApiKeyRow => {
  const prefix = key.prefix;
  const revoke = key.revoke;
  return {
    id: key.id,
    name: key.name,
    description: key.description ?? null,
    prefix: typeof prefix === "string" ? prefix : key.id,
    secret: key.secret,
    revoked: key.revoked ?? false,
    expiration: key.expiration ?? null,
    lastUsedAt: key.lastUsedAt ?? null,
    createdAt: key.createdAt ?? 0,
    revoke: typeof revoke === "function" ? () => Promise.resolve(revoke.call(key)) : undefined,
  };
};

/** API keys: list, create (one-time secret reveal), revoke. */
export function APIKeys(props: APIKeysProps) {
  return (
    <OrgRoot
      appearance={props.appearance}
      className={props.className}
      element="apiKeys"
      requiresOrganizations={props.type === "organization"}
    >
      <APIKeysView {...props} />
    </OrgRoot>
  );
}

function APIKeysView({ type = "user", perPage = 10, showDescription }: APIKeysProps) {
  const portalClass = usePortalClass();
  const { t } = useLocalizations();
  const instance = useOrbitID();
  const { organization } = useOrgScope({
    memberships: false,
    invitations: false,
    domains: false,
    membershipRequests: false,
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [revealed, setRevealed] = useState<ApiKeyRow | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [expiration, setExpiration] = useState<ExpirationChoice>("never");
  const [customDays, setCustomDays] = useState("30");
  const [scopes, setScopes] = useState("");
  const clipboard = useClipboard();

  const subject = useMemo(
    () =>
      type === "user"
        ? ({ type: "user" } as const)
        : organization
          ? ({ type: "organization", organizationId: organization.id } as const)
          : null,
    [type, organization],
  );

  // Prefer the SDK resources (`orbit.apiKeys`, `organization.apiKeys`); fall back to the
  // Frontend API for SDK builds that predate them.
  const sdkApiKeys = type === "organization" ? organization?.apiKeys : instance.apiKeys;

  const keys = usePagedResource<ApiKeyRow>({
    key: `api-keys:${type}:${organization?.id ?? "user"}`,
    fetcher: async (args) => {
      if (sdkApiKeys) {
        const page = await sdkApiKeys.list({ limit: args.limit, offset: args.offset });
        return { data: page.data.map(rowFromResource), totalCount: page.totalCount };
      }
      if (!subject) return { data: [], totalCount: 0 };
      const page = await listApiKeys(instance, subject, {
        limit: args.limit,
        offset: args.offset,
      });
      return { data: page.data.map(rowFromJson), totalCount: page.totalCount };
    },
    pageSize: perPage,
    enabled: Boolean(sdkApiKeys ?? subject),
  });

  const table = usePaginatedTable(keys, perPage);
  const createAction = useAsyncAction(
    async (input: { name: string; description?: string; expiration: number | null; scopes: string[] }) => {
      if (sdkApiKeys) {
        const created = await sdkApiKeys.create(input);
        await keys.revalidate();
        return rowFromResource(created);
      }
      if (!subject) return undefined;
      const created = await createApiKey(instance, subject, input);
      await keys.revalidate();
      return rowFromJson(created);
    },
  );
  const revokeAction = useAsyncAction(async (key: ApiKeyRow) => {
    if (key.revoke) {
      await key.revoke();
    } else if (subject) {
      await revokeApiKey(instance, subject, key.id);
    } else {
      return false;
    }
    await keys.revalidate();
    return true;
  });
  const createError = useOrgErrorText(createAction.error);
  const revokeError = useOrgErrorText(revokeAction.error);
  const listError = useOrgErrorText(keys.error);

  const resetForm = () => {
    setName("");
    setDescription("");
    setExpiration("never");
    setCustomDays("30");
    setScopes("");
  };

  const expirationValue = (): number | null => {
    if (expiration === "never") return null;
    if (expiration === "30") return Date.now() + 30 * DAY_MS;
    if (expiration === "90") return Date.now() + 90 * DAY_MS;
    const days = Number.parseInt(customDays, 10);
    return Number.isFinite(days) && days > 0 ? Date.now() + days * DAY_MS : null;
  };

  const customDaysValid =
    expiration !== "custom" || (Number.parseInt(customDays, 10) > 0 && Number.isFinite(Number(customDays)));

  const submitCreate = async () => {
    if (!customDaysValid) return;
    const key = await createAction.run({
      name: name.trim(),
      ...(showDescription && description.trim() ? { description: description.trim() } : {}),
      expiration: expirationValue(),
      scopes: scopes
        .split(",")
        .map((scope) => scope.trim())
        .filter(Boolean),
    });
    if (!key) return;
    setCreateOpen(false);
    resetForm();
    setRevealed(key);
  };

  if (type === "organization" && !organization) {
    return <EmptyState>{t("apiKeys.noOrganization")}</EmptyState>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col gap-1">
          <h3 className="flex items-center gap-2 font-medium">
            <KeyRoundIcon className="size-4" aria-hidden="true" />
            {t("apiKeys.title")}
          </h3>
          <p className="text-sm text-muted-foreground">{t("apiKeys.subtitle")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          onClick={() => {
            resetForm();
            setCreateOpen(true);
          }}
        >
          <PlusIcon aria-hidden="true" />
          {t("apiKeys.addApiKey")}
        </Button>
      </div>

      <ErrorBanner message={revokeError} />
      <ErrorBanner message={listError} onRetry={() => void keys.revalidate()} />

      {table.isLoading ? (
        <LoadingRows />
      ) : table.items.length === 0 ? (
        <EmptyState>{t("apiKeys.noApiKeys")}</EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("apiKeys.formNameLabel")}</TableHead>
              <TableHead>{t("apiKeys.columnKey")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("apiKeys.columnCreated")}</TableHead>
              <TableHead className="hidden sm:table-cell">{t("apiKeys.formExpirationLabel")}</TableHead>
              <TableHead className="hidden md:table-cell">{t("apiKeys.lastUsedLabel")}</TableHead>
              <TableHead>{t("apiKeys.columnStatus")}</TableHead>
              <TableHead className="text-right">{t("apiKeys.columnActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.items.map((key) => {
              const expired = isApiKeyExpired(key.expiration);
              return (
                <TableRow key={key.id} data-testid={`api-key-row-${key.id}`}>
                  <TableCell>
                    <div className="flex min-w-0 flex-col">
                      <span className="max-w-[28ch] truncate font-medium" title={key.name}>{key.name}</span>
                      {showDescription && key.description ? (
                        <span className="max-w-[28ch] truncate text-xs text-muted-foreground" title={key.description}>{key.description}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <span className="block max-w-[20ch] truncate" title={key.prefix ?? key.id}>{key.prefix ?? key.id}</span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {formatDate(key.createdAt)}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {key.expiration ? formatDate(key.expiration) : t("apiKeys.expiryNever")}
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground md:table-cell">
                    {key.lastUsedAt ? formatDate(key.lastUsedAt) : t("apiKeys.neverUsed")}
                  </TableCell>
                  <TableCell>
                    <Badge variant={key.revoked || expired ? "outline" : "secondary"}>
                      {key.revoked
                        ? t("apiKeys.revoked")
                        : expired
                          ? t("badge__expired")
                          : t("badge__active")}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    {key.revoked ? null : (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`${t("apiKeys.revoke")} ${key.name}`}
                        onClick={() => setRevokeTarget(key)}
                      >
                        <Trash2Icon aria-hidden="true" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <PaginationBar {...table} />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className={portalClass("sm:max-w-md")}>
          <DialogHeader>
            <DialogTitle>{t("apiKeys.createTitle")}</DialogTitle>
            <DialogDescription>{t("apiKeys.createSubtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api-key-name">{t("apiKeys.formNameLabel")}</Label>
              <Input
                id="api-key-name"
                value={name}
                autoComplete="off"
                placeholder={t("formFieldInputPlaceholder__apiKeyName")}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            {showDescription ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="api-key-description">{t("apiKeys.formDescriptionLabel")}</Label>
                <Input
                  id="api-key-description"
                  value={description}
                  autoComplete="off"
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api-key-expiration">{t("apiKeys.formExpirationLabel")}</Label>
              <Select
                value={expiration}
                onValueChange={(value) => setExpiration(value as ExpirationChoice)}
              >
                <SelectTrigger id="api-key-expiration" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className={portalClass()}>
                  <SelectItem value="never">{t("apiKeys.expiryNever")}</SelectItem>
                  <SelectItem value="30">{t("apiKeys.expiration30Days")}</SelectItem>
                  <SelectItem value="90">{t("apiKeys.expiration90Days")}</SelectItem>
                  <SelectItem value="custom">{t("apiKeys.expirationCustom")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {expiration === "custom" ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="api-key-custom-days">{t("apiKeys.customDaysLabel")}</Label>
                <Input
                  id="api-key-custom-days"
                  type="number"
                  min={1}
                  value={customDays}
                  onChange={(event) => setCustomDays(event.target.value)}
                />
              </div>
            ) : null}
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="api-key-scopes">{t("apiKeys.scopesLabel")}</Label>
              <Input
                id="api-key-scopes"
                value={scopes}
                autoComplete="off"
                placeholder="users:read, organizations:read"
                onChange={(event) => setScopes(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t("apiKeys.scopesHint")}</p>
            </div>
            <ErrorBanner message={createError} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
              {t("apiKeys.cancel")}
            </Button>
            <Button
              type="button"
              disabled={createAction.isPending || name.trim().length === 0 || !customDaysValid}
              onClick={() => void submitCreate()}
            >
              {createAction.isPending ? t("status.loading") : t("apiKeys.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={revealed !== null}
        onOpenChange={(open) => {
          if (!open) setRevealed(null);
        }}
      >
        <DialogContent className={portalClass("sm:max-w-md")}>
          <DialogHeader>
            <DialogTitle>{t("apiKeys.revealTitle")}</DialogTitle>
            <DialogDescription>{t("apiKeys.revealSubtitle")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label>{t("apiKeys.secretLabel")}</Label>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 overflow-x-auto rounded-md border bg-muted px-2 py-1.5 font-mono text-xs"
                data-testid="api-key-secret"
              >
                {revealed?.secret ?? ""}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  if (revealed?.secret) void clipboard.copy(revealed.secret);
                }}
              >
                <CopyIcon aria-hidden="true" />
                {clipboard.copied ? t("apiKeys.copied") : t("apiKeys.copy")}
              </Button>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" onClick={() => setRevealed(null)}>
              {t("apiKeys.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setRevokeTarget(null);
        }}
        title={t("apiKeys.revokeTitle")}
        description={t("apiKeys.revokeSubtitle")}
        confirmLabel={t("apiKeys.revokeConfirm")}
        destructive
        error={revokeError}
        onConfirm={async () => {
          if (!revokeTarget) return;
          const revoked = await revokeAction.run(revokeTarget);
          if (!revoked) return;
          setRevokeTarget(null);
        }}
      />
    </div>
  );
}
