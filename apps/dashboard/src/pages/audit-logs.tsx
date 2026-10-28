import { useState } from "react";
import type { AuditLogJSON, PaginatedList } from "@orbitid/shared";
import {
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
import {
  CopyButton,
  DetailSheet,
  EmptyState,
  ErrorAlert,
  MetaChip,
  PageHeader,
  RuledTable,
  TableSkeleton,
} from "./_config/ui";

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
        description="Administrative and security-relevant actions across the instance. Records are immutable and ordered by time."
        badge={<MetaChip>{total.toLocaleString()} events</MetaChip>}
        actions={
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching}>
            <RefreshCw className={`size-4 ${query.isFetching ? "animate-spin" : ""}`} aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="space-y-3 border-y border-border py-3">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
            <Input
              value={action}
              onChange={(event) => {
                setAction(event.target.value);
                setOffset(0);
              }}
              placeholder="Action, for example user.created"
              className="pl-8 font-data text-xs"
              aria-label="Filter by action"
            />
          </div>
          <Input
            value={actor}
            onChange={(event) => {
              setActor(event.target.value);
              setOffset(0);
            }}
            placeholder="Actor user ID"
            className="font-data text-xs"
            aria-label="Filter by actor"
          />
          <Input
            value={targetId}
            onChange={(event) => {
              setTargetId(event.target.value);
              setOffset(0);
            }}
            placeholder="Target ID"
            className="font-data text-xs"
            aria-label="Filter by target ID"
          />
          <Select
            value={targetType}
            onValueChange={(value) => {
              setTargetType(value);
              setOffset(0);
            }}
          >
            <SelectTrigger className="w-full" aria-label="Filter by target type">
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
            id="audit-from"
            type="date"
            value={dateFrom}
            onChange={(event) => {
              setDateFrom(event.target.value);
              setOffset(0);
            }}
            className="font-data text-xs"
            aria-label="From date"
          />
          <Input
            id="audit-to"
            type="date"
            value={dateTo}
            onChange={(event) => {
              setDateTo(event.target.value);
              setOffset(0);
            }}
            className="font-data text-xs"
            aria-label="To date"
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className="text-xs text-muted-foreground">
            {activeFilters > 0
              ? `${activeFilters} filter${activeFilters === 1 ? "" : "s"} applied`
              : "No filters. Newest events first."}
          </span>
          {activeFilters > 0 ? (
            <Button variant="ghost" size="sm" onClick={resetFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>
      </div>

      {query.error ? (
        <ErrorAlert error={query.error.message} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <TableSkeleton rows={10} />
      ) : logs.length === 0 ? (
        <EmptyState
          title="No audit events"
          description={
            activeFilters > 0
              ? "No events match the current filters. Clear a filter or widen the date range."
              : "Actions appear here as users and administrators use the instance."
          }
        />
      ) : (
        <div className="space-y-3">
          <RuledTable>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[146px]">Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead className="w-[180px]">Actor</TableHead>
                <TableHead className="w-[230px]">Target</TableHead>
                <TableHead className="w-[110px]">IP</TableHead>
                <TableHead className="w-12 text-right">Detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {logs.map((log) => (
                <TableRow key={log.id}>
                  <TableCell className="font-data text-xs text-muted-foreground">{formatDate(log.created_at)}</TableCell>
                  <TableCell>
                    <code className="font-data text-xs font-medium">{log.action}</code>
                  </TableCell>
                  <TableCell>
                    <span className="block truncate font-data text-xs">{log.actor ?? "system"}</span>
                  </TableCell>
                  <TableCell>
                    <span className="block truncate text-xs">
                      {log.target_type ? (
                        <>
                          <span className="text-muted-foreground">{log.target_type} </span>
                          <span className="font-data">{log.target_id ?? ""}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">None</span>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="font-data text-xs text-muted-foreground">{log.ip ?? "None"}</TableCell>
                  <TableCell className="text-right">
                    <Button variant="ghost" size="icon-sm" onClick={() => setMetadata(log)} title="Metadata">
                      <Eye className="size-4" aria-hidden />
                      <span className="sr-only">Metadata for {log.action}</span>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </RuledTable>
          <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span className="font-data">
              {offset + 1} to {offset + logs.length} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>
                <ChevronLeft className="size-4" aria-hidden /> Previous
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={offset + logs.length >= total}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight className="size-4" aria-hidden />
              </Button>
            </div>
          </div>
        </div>
      )}

      <DetailSheet
        open={metadata !== null}
        onOpenChange={(open) => !open && setMetadata(null)}
        size="lg"
        title={metadata?.action ?? "Audit event"}
        description={metadata ? `${formatDate(metadata.created_at)}, ${metadata.actor ?? "system"}` : undefined}
        footer={<Button variant="outline" onClick={() => setMetadata(null)}>Close</Button>}
      >
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-medium">Metadata</p>
            {metadata ? (
              <CopyButton value={JSON.stringify(metadata.metadata, null, 2)} size="sm" variant="outline" label="Copy JSON" />
            ) : null}
          </div>
          <pre className="max-h-96 overflow-auto border border-border bg-muted/40 p-3 font-data text-xs leading-relaxed">
            {metadata ? JSON.stringify(metadata.metadata, null, 2) : ""}
          </pre>
          {metadata ? (
            <dl className="divide-y divide-border border-y border-border text-xs">
              <div className="flex justify-between gap-4 py-1.5">
                <dt className="text-muted-foreground">Actor</dt>
                <dd className="font-data">{metadata.actor ?? "system"}</dd>
              </div>
              <div className="flex justify-between gap-4 py-1.5">
                <dt className="text-muted-foreground">Target</dt>
                <dd className="font-data">
                  {metadata.target_type ? `${metadata.target_type} ${metadata.target_id ?? ""}` : "None"}
                </dd>
              </div>
              <div className="flex justify-between gap-4 py-1.5">
                <dt className="text-muted-foreground">IP address</dt>
                <dd className="font-data">{metadata.ip ?? "None"}</dd>
              </div>
            </dl>
          ) : null}
        </div>
      </DetailSheet>
    </div>
  );
}
