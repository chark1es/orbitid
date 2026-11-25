import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Eye, Pencil, Plus, Trash2 } from "lucide-react";
import { formatDate } from "../_config/settings";
import { EmptyState, RuledTable, TableSkeleton } from "../_config/ui";
import type { OAuthAppsController } from "./use-oauth-apps";
import { ownerLabel } from "../../lib/app-ownership";

export function ApplicationsTable({ ctl }: { ctl: OAuthAppsController }) {
  const { setDetail, setSelected, query, applications, organizations, openCreate, openEdit } = ctl;

  return (
    <>
      {query.isLoading ? (
        <TableSkeleton />
      ) : applications.length === 0 ? (
        <EmptyState
          compact
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
              <TableHead className="hidden sm:table-cell">Owner</TableHead>
              <TableHead className="hidden xl:table-cell">Client ID</TableHead>
              <TableHead className="hidden md:table-cell">Type</TableHead>
              <TableHead className="hidden text-right lg:table-cell">Redirect URIs</TableHead>
              <TableHead className="hidden lg:table-cell">PKCE</TableHead>
              <TableHead className="hidden xl:table-cell">Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {applications.map((application) => (
              <TableRow key={application.id}>
                <TableCell className="text-sm font-medium">
                  <span className="block max-w-[32ch] truncate" title={application.name}>{application.name}</span>
                </TableCell>
                <TableCell className="hidden text-xs sm:table-cell">
                  <span
                    className={application.organization_id ? "block max-w-[24ch] truncate" : "text-muted-foreground"}
                    title={ownerLabel(application.organization_id, organizations)}
                  >
                    {ownerLabel(application.organization_id, organizations)}
                  </span>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  <code className="block max-w-[18rem] truncate font-data text-xs" title={application.client_id}>{application.client_id}</code>
                </TableCell>
                <TableCell className="hidden text-xs text-muted-foreground md:table-cell">{application.public ? "Public" : "Confidential"}</TableCell>
                <TableCell className="hidden text-right font-data text-xs lg:table-cell">{application.redirect_uris.length}</TableCell>
                <TableCell className="hidden text-xs text-muted-foreground lg:table-cell">{application.pkce_required ? "Required" : "Optional"}</TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground xl:table-cell">{formatDate(application.created_at)}</TableCell>
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
