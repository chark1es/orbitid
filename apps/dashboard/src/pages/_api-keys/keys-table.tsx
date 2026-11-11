import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Trash2 } from "lucide-react";
import type { ApiKeyJSON } from "@orbitid/shared";
import { formatDate } from "../_config/settings";
import { RuledTable, StatusBadge } from "../_config/ui";

export function ApiKeysTable({ keys, onRevoke }: { keys: ApiKeyJSON[]; onRevoke: (key: ApiKeyJSON) => void }) {
  return (
    <RuledTable>
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Subject</TableHead>
          <TableHead>Scopes</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Expires</TableHead>
          <TableHead>Last used</TableHead>
          <TableHead className="w-16 text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {keys.map((key) => {
          const expired = Boolean(key.expiration && key.expiration < Date.now());
          return (
            <TableRow key={key.id}>
              <TableCell>
                <div className="space-y-0.5">
                  <p className="max-w-[28ch] truncate text-sm font-medium" title={key.name}>{key.name}</p>
                  <code className="font-data text-xs text-muted-foreground">{key.prefix}…</code>
                </div>
              </TableCell>
              <TableCell>
                <div className="space-y-0.5">
                  <p className="text-xs text-muted-foreground">{key.subject.startsWith("org_") ? "Organization" : "User"}</p>
                  <code className="block max-w-[16rem] truncate font-data text-xs">{key.subject}</code>
                </div>
              </TableCell>
              <TableCell>
                <span className="block max-w-[18rem] truncate font-data text-xs text-muted-foreground">{key.scopes.join(", ")}</span>
              </TableCell>
              <TableCell>
                <StatusBadge status={key.revoked ? "revoked" : expired ? "expired" : "active"} />
              </TableCell>
              <TableCell className="font-data text-xs text-muted-foreground">{formatDate(key.expiration)}</TableCell>
              <TableCell className="font-data text-xs text-muted-foreground">{formatDate(key.last_used_at)}</TableCell>
              <TableCell className="text-right">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="text-destructive"
                  disabled={key.revoked}
                  onClick={() => onRevoke(key)}
                  title="Revoke"
                >
                  <Trash2 className="size-4" aria-hidden />
                  <span className="sr-only">Revoke {key.name}</span>
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </RuledTable>
  );
}
