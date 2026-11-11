import { Globe } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { formatDate } from "../../lib/format";
import { EmptyState } from "../shared/empty-state";
import { Section } from "../shared/section";
import { LabelChip, StatusBadge } from "../shared/status-badge";
import { CopyButton } from "../shared/copy-button";

interface IdentifierRow { id: string; value: string; verified: boolean; primary: boolean; createdAt: number }

function IdentifierGroup({ title, rows }: { title: string; rows: IdentifierRow[] }) {
  return <div className="min-w-0">
    <h3 className="border-b border-border pb-2 text-sm font-medium">{title}</h3>
    {rows.length === 0 ? <EmptyState className="py-8" title={`No ${title.toLowerCase()}`} description="The user can add and verify an identifier in their account settings." /> : <ul>
      {rows.map((row) => <li key={row.id} className="flex flex-wrap items-center gap-2 border-b border-border py-2.5 last:border-b-0">
        <span className="min-w-0 flex-1 truncate font-data text-sm">{row.value}</span>
        {row.primary ? <LabelChip>Primary</LabelChip> : null}
        <StatusBadge status={row.verified ? "verified" : "unverified"} />
        <span className="hidden font-data text-xs text-muted-foreground sm:inline">{formatDate(row.createdAt)}</span>
        <CopyButton value={row.value} label="Copy identifier" />
      </li>)}
    </ul>}
  </div>;
}

export function UserIdentifiersTab({ user }: { user: UserJSON; onUpdated: () => void }) {
  const emails = user.email_addresses.map((email) => ({ id: email.id, value: email.email_address, verified: email.verification?.status === "verified", primary: email.id === user.primary_email_address_id, createdAt: email.created_at }));
  const phones = user.phone_numbers.map((phone) => ({ id: phone.id, value: phone.phone_number, verified: phone.verification?.status === "verified", primary: phone.id === user.primary_phone_number_id, createdAt: phone.created_at }));
  return <Section title="Identifiers" description="Only the user can add, verify, change or remove their sign-in identifiers through their account settings." className="border-t-0 pt-0">
    <div className="grid gap-5 lg:grid-cols-2">
      <IdentifierGroup title="Email addresses" rows={emails} />
      <IdentifierGroup title="Phone numbers" rows={phones} />
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
                <LabelChip className="capitalize">
                  {account.provider.replace(/_/g, " ")}
                </LabelChip>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {account.email_address || account.username || account.provider_user_id}
                </span>
                <span className="font-data text-xs text-muted-foreground">{formatDate(account.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
  </Section>;
}
