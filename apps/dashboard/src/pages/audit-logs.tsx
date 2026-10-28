import { useState } from "react";
import type { AuditLogJSON, PaginatedList } from "@orbitid/shared";
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
import { ChevronLeft, ChevronRight, Eye, RefreshCw, Search } from "lucide-react";
import { useApi } from "../lib/api";
import { unwrapList, unwrapTotal } from "./_config/data";
import { formatDate, fromDateInput, fromDateInputStart } from "./_config/settings";
import { CopyButton, EmptyState, ErrorAlert, Field, PageHeader, TableSkeleton } from "./_config/ui";

const PAGE_SIZE = 50;

export default function Page() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [targetType, setTargetType] = useState("all");
  const [targetId, setTargetId] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [offset, setOffset] = useState(0);
  const [metadata, setMetadata] = useState<AuditLogJSON | null>(null);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) });
  if (action.trim()) params.set("action", action.trim());
  if (actor.trim()) params.set("actor", actor.trim());
  if (targetType !== "all") params.set("target_type", targetType);
  if (targetId.trim()) params.set("target_id", targetId.trim());
  if (dateFrom) params.set("after", String(fromDateInputStart(dateFrom)));
  if (dateTo) params.set("before", String(fromDateInput(dateTo)));

  const queryKey = ["audit-logs", action, actor, targetType, targetId, dateFrom, dateTo, offset];
  const query = useApi<PaginatedList<AuditLogJSON>>(queryKey, `/audit_logs?${params.toString()}`);
  const logs = unwrapList<AuditLogJSON>(query.data);
  const total = unwrapTotal(query.data, logs.length);
  const activeFilters = [action, actor, targetId, dateFrom, dateTo].filter(Boolean).length + (targetType !== "all" ? 1 : 0);

  const resetFilters = () => {
    setAction("");
    setActor("");
    setTargetType("all");
    setTargetId("");
    setDateFrom("");
    setDateTo("");
    setOffset(0);
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audit logs"
        description="Administrative and security-relevant actions across the instance. Records are immutable and time-ordered."
        badge={<Badge variant="outline">{total.toLocaleString()} events</Badge>}
        actions={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} /> Refresh
          </Button>
        }
      />

      <div className="rounded-xl border bg-card p-3">
        <div className="grid gap-2 lg:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
            <Input
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setOffset(0);
              }}
              placeholder="Action, e.g. user.created"
              className="pl-8"
            />
          </div>
          <Input
            value={actor}
            onChange={(event) => {
              setActor(event.target.value);
              setOffset(0);
            }}
            placeholder="Actor user ID"
          />
          <Select
            value={targetType}
            onValueChange={(value) => {
              setTargetType(value);
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All target types</SelectItem>
              <SelectItem value="user">User</SelectItem>
              <SelectItem value="session">Session</SelectItem>
              <SelectItem value="organization">Organization</SelectItem>
              <SelectItem value="organization_membership">Organization membership</SelectItem>
              <SelectItem value="invitation">Invitation</SelectItem>
              <SelectItem value="api_key">API key</SelectItem>
              <SelectItem value="webhook_endpoint">Webhook endpoint</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setOffset(0);
            }}
            placeholder="Target ID"
          />
          <Field label="From" htmlFor="audit-from">
            <Input
              id="audit-from"
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setOffset(0);
              }}
            />
          </Field>
          <Field label="To" htmlFor="audit-to">
            <Input
              id="audit-to"
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value);
                setOffset(0);
              }}
            />
          </Field>
        </div>
        {activeFilters > 0 ? (
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-muted-foreground">{activeFilters} filter{activeFilters === 1 ? "" : "s"} applied</span>
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          </div>
        ) : null}
      </div>

      {query.error ? (
        <ErrorAlert error={query.error.message} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <TableSkeleton rows={8} />
      ) : logs.length === 0 ? (
        <EmptyState title="No audit events" description={activeFilters > 0 ? "No events match the current filters." : "Actions will appear here as users and administrators use the instance."} />
      ) : (
        <div className="space-y-2">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Action</TableHead>
                  <TableHead>Actor</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>IP</TableHead>
                  <TableHead className="w-12" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.map((log) => (
                  <TableRow key={log.id}>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{formatDate(log.created_at)}</TableCell>
                    <TableCell>
                      <code className="text-xs font-medium">{log.action}</code>
                    </TableCell>
                    <TableCell className="max-w-[14rem] truncate font-mono text-xs">{log.actor ?? "system"}</TableCell>
                    <TableCell>
                      {log.target_type ? (
                        <div className="space-y-0.5">
                          <Badge variant="outline">{log.target_type}</Badge>
                          <p className="max-w-[14rem] truncate font-mono text-xs text-muted-foreground">{log.target_id ?? "—"}</p>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{log.ip ?? "—"}</TableCell>
                    <TableCell>
                      <Button variant="ghost" size="icon-sm" onClick={() => setMetadata(log)} title="Metadata">
                        <Eye className="size-4" />
                        <span className="sr-only">Metadata</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              Showing {offset + 1}–{offset + logs.length} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft className="size-4" /> Previous
              </Button>
              <Button variant="outline" size="sm" disabled={offset + logs.length >= total} onClick={() => setOffset(offset + PAGE_SIZE)}>
                Next <ChevronRight className="size-4" />
              </Button>
            </div>
          </div>
        </div>
      )}

      <Dialog open={metadata !== null} onOpenChange={(open) => !open && setMetadata(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{metadata?.action}</DialogTitle>
            <DialogDescription>
              {metadata ? `${formatDate(metadata.created_at)} · ${metadata.actor ?? "system"}` : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium">Metadata</p>
              {metadata ? <CopyButton value={JSON.stringify(metadata.metadata, null, 2)} size="sm" variant="outline" label="Copy JSON" /> : null}
            </div>
            <pre className="max-h-96 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
              {metadata ? JSON.stringify(metadata.metadata, null, 2) : ""}
            </pre>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setMetadata(null)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
