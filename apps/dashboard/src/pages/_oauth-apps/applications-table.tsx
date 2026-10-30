import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { formatDate } from "../_config/settings";
import { EmptyState, RuledTable, TableSkeleton } from "../_config/ui";
import type { OAuthAppsController } from "./use-oauth-apps";

export function ApplicationsTable({ ctl }: { ctl: OAuthAppsController }) {
  const { setDetail, setSelected, query, applications, openCreate, openEdit } = ctl;

  return (
    <>
      {query.isLoading ? (
        <TableSkeleton />
      ) : applications.length === 0 ? (
        <EmptyState
          title="No OAuth applications"
          description="Register a first-party or third-party application so users can sign in to it with OrbitID."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Create application
            </Button>
          }
        />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Application</TableHead>
              <TableHead>Client ID</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Redirect URIs</TableHead>
              <TableHead>PKCE</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((application) => (
              <TableRow key={application.id}>
                <TableCell className="text-sm font-medium">{application.name}</TableCell>
                <TableCell>
                  <code className="block max-w-[18rem] truncate font-data text-xs">{application.client_id}</code>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{application.public ? "Public" : "Confidential"}</TableCell>
                <TableCell className="text-right font-data text-xs">{application.redirect_uris.length}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{application.pkce_required ? "Required" : "Optional"}</TableCell>
                <TableCell className="font-data text-xs text-muted-foreground">{formatDate(application.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDetail(application)} title="Details">
                      <Eye className="size-4" aria-hidden />
                      <span className="sr-only">Details for {application.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(application)} title="Edit">
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {application.name}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(application)} title="Delete">
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {application.name}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </RuledTable>
      )}
    </>
  );
}
