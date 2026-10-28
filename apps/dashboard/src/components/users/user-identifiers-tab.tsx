import { useState } from "react";
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
  Switch,
} from "@orbitid/ui";
import { CheckCircle2, Globe, Plus, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { EmailAddressJSON, PhoneNumberJSON, UserJSON } from "@orbitid/shared";
import { api } from "../../lib/api";
import { errorMessage } from "../../lib/errors";
import { formatDate } from "../../lib/format";
import { ConfirmDialog } from "../shared/confirm-dialog";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";
import { StatusBadge } from "../shared/status-badge";
import { CopyButton } from "../shared/copy-button";

interface IdentifierRow {
  id: string;
  value: string;
  verified: boolean;
  primary: boolean;
  createdAt: number;
}

interface AddIdentifierInput {
  value: string;
  verified: boolean;
  primary: boolean;
}

function AddIdentifierDialog({
  open,
  onOpenChange,
  kind,
  pending,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: "email" | "phone";
  pending: boolean;
  onSubmit: (value: AddIdentifierInput) => void;
}) {
  const [value, setValue] = useState("");
  const [verified, setVerified] = useState(true);
  const [primary, setPrimary] = useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setValue("");
          setVerified(true);
          setPrimary(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add {kind === "email" ? "email address" : "phone number"}</DialogTitle>
          <DialogDescription>
            {kind === "email"
              ? "The address must be unique on the instance."
              : "Use E.164 format, for example +15551234567."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (!value.trim()) return;
            onSubmit({ value: value.trim(), verified, primary });
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="new-identifier">{kind === "email" ? "Email address" : "Phone number"}</Label>
            <Input
              id="new-identifier"
              type={kind === "email" ? "email" : "tel"}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder={kind === "email" ? "ada@example.com" : "+15551234567"}
              autoFocus
            />
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="new-identifier-verified">Mark as verified</Label>
              <Switch id="new-identifier-verified" checked={verified} onCheckedChange={setVerified} />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="new-identifier-primary">Set as primary</Label>
              <Switch id="new-identifier-primary" checked={primary} onCheckedChange={setPrimary} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !value.trim()}>
              Add {kind}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function IdentifierGroup({
  title,
  description,
  rows,
  addKind,
  onAdd,
  onVerify,
  onSetPrimary,
  onDelete,
  pending,
}: {
  title: string;
  description: string;
  rows: IdentifierRow[];
  addKind: "email" | "phone";
  onAdd: (value: AddIdentifierInput) => void;
  onVerify: (row: IdentifierRow) => void;
  onSetPrimary: (row: IdentifierRow) => void;
  onDelete: (row: IdentifierRow) => void;
  pending: boolean;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const [deleting, setDeleting] = useState<IdentifierRow | null>(null);

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-2">
        <div className="min-w-0 space-y-1">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs leading-5 text-muted-foreground">{description}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
          <Plus aria-hidden /> Add
        </Button>
      </div>
      {rows.length === 0 ? (
        <EmptyState
          className="py-8"
          title={`No ${addKind === "email" ? "email addresses" : "phone numbers"}`}
          description="Identifiers let the user sign in and receive verification codes."
        />
      ) : (
        <ul>
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 border-b border-border py-2.5 last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate font-data text-sm">{row.value}</span>
              {row.primary ? <Badge variant="secondary">Primary</Badge> : null}
              <StatusBadge status={row.verified ? "verified" : "unverified"} />
              <span className="hidden font-data text-xs text-muted-foreground sm:inline">
                {formatDate(row.createdAt)}
              </span>
              <div className="flex items-center gap-1">
                {!row.verified ? (
                  <Button size="xs" variant="ghost" onClick={() => onVerify(row)} disabled={pending}>
                    <CheckCircle2 aria-hidden /> Verify
                  </Button>
                ) : null}
                {row.verified && !row.primary ? (
                  <Button size="xs" variant="ghost" onClick={() => onSetPrimary(row)} disabled={pending}>
                    <Star aria-hidden /> Primary
                  </Button>
                ) : null}
                <CopyButton value={row.value} label="Copy identifier" />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${row.value}`}
                  onClick={() => setDeleting(row)}
                  disabled={pending}
                >
                  <Trash2 aria-hidden />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AddIdentifierDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        kind={addKind}
        pending={pending}
        onSubmit={(value) => {
          onAdd(value);
          setAddOpen(false);
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={`Delete ${addKind === "email" ? "email address" : "phone number"}?`}
        description={
          deleting ? (
            <>
              <span className="font-data text-xs">{deleting.value}</span> is removed as a sign-in identifier. This cannot be
              undone.
            </>
          ) : undefined
        }
        destructive
        confirmLabel="Delete"
        pending={pending}
        onConfirm={() => {
          if (deleting) onDelete(deleting);
          setDeleting(null);
        }}
      />
    </div>
  );
}

export function UserIdentifiersTab({ user, onUpdated }: { user: UserJSON; onUpdated: () => void }) {
  const [pending, setPending] = useState(false);

  async function run(request: () => Promise<unknown>, success: string) {
    setPending(true);
    try {
      await request();
      toast.success(success);
      onUpdated();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  const emails: IdentifierRow[] = user.email_addresses.map((email: EmailAddressJSON) => ({
    id: email.id,
    value: email.email_address,
    verified: email.verification?.status === "verified",
    primary: email.id === user.primary_email_address_id,
    createdAt: email.created_at,
  }));
  const phones: IdentifierRow[] = user.phone_numbers.map((phone: PhoneNumberJSON) => ({
    id: phone.id,
    value: phone.phone_number,
    verified: phone.verification?.status === "verified",
    primary: phone.id === user.primary_phone_number_id,
    createdAt: phone.created_at,
  }));

  return (
    <Section
      title="Identifiers"
      description="Addresses the user signs in with and accounts linked through a provider."
      className="border-t-0 pt-0"
    >
      <div className="grid gap-5 lg:grid-cols-2">
        <IdentifierGroup
          title="Email addresses"
          description="Sign-in identifiers and email-code destinations."
          rows={emails}
          addKind="email"
          pending={pending}
          onAdd={(value) =>
            void run(
              () =>
                api("POST", "/email_addresses", {
                  user_id: user.id,
                  email_address: value.value,
                  verified: value.verified,
                  primary: value.primary,
                }),
              "Email address added",
            )
          }
          onVerify={(row) => void run(() => api("PATCH", `/email_addresses/${row.id}`, { verified: true }), "Email verified")}
          onSetPrimary={(row) =>
            void run(() => api("PATCH", `/users/${user.id}`, { primary_email_address_id: row.id }), "Primary email updated")
          }
          onDelete={(row) => void run(() => api("DELETE", `/email_addresses/${row.id}`), "Email address deleted")}
        />

        <IdentifierGroup
          title="Phone numbers"
          description="Usable for SMS codes and as a second factor."
          rows={phones}
          addKind="phone"
          pending={pending}
          onAdd={(value) =>
            void run(
              () =>
                api("POST", "/phone_numbers", {
                  user_id: user.id,
                  phone_number: value.value,
                  verified: value.verified,
                  primary: value.primary,
                }),
              "Phone number added",
            )
          }
          onVerify={(row) => void run(() => api("PATCH", `/phone_numbers/${row.id}`, { verified: true }), "Phone verified")}
          onSetPrimary={(row) =>
            void run(() => api("PATCH", `/users/${user.id}`, { primary_phone_number_id: row.id }), "Primary phone updated")
          }
          onDelete={(row) => void run(() => api("DELETE", `/phone_numbers/${row.id}`), "Phone number deleted")}
        />
      </div>

      <div className="mt-6 min-w-0">
        <div className="space-y-1 border-b border-border pb-2">
          <h3 className="text-sm font-medium">Social accounts</h3>
          <p className="text-xs leading-5 text-muted-foreground">
            External accounts linked through OAuth. Users connect these themselves.
          </p>
        </div>
        {user.external_accounts.length === 0 ? (
          <EmptyState
            className="py-8"
            icon={Globe}
            title="No social accounts"
            description="OAuth connections appear here after the user links one."
          />
        ) : (
          <ul>
            {user.external_accounts.map((account) => (
              <li
                key={account.id}
                className="flex flex-wrap items-center gap-2 border-b border-border py-2.5 last:border-b-0"
              >
                <Badge variant="outline" className="capitalize">
                  {account.provider.replace(/_/g, " ")}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {account.email_address || account.username || account.provider_user_id}
                </span>
                <span className="font-data text-xs text-muted-foreground">{formatDate(account.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Section>
  );
}
