import type { ReactNode } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@orbitid/ui";
import { ArrowDown, ArrowUp, ArrowUpDown, Loader2, TriangleAlert } from "lucide-react";
import { Button } from "@orbitid/ui";
import { EmptyState } from "./empty-state";

export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  className?: string;
  headerClassName?: string;
  /** Backend `order_by` field; enables the sort toggle. */
  sortKey?: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  isLoading = false,
  error,
  onRetry,
  empty,
  sortKey,
  sortDescending,
  onSort,
  onRowClick,
  loadingRows = 8,
  className,
}: {
  columns: DataTableColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  empty?: ReactNode;
  sortKey?: string;
  sortDescending?: boolean;
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  loadingRows?: number;
  className?: string;
}) {
  const columnCount = columns.length;
  return (
    <div className={cn("overflow-hidden rounded-lg border bg-card", className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const active = !!column.sortKey && sortKey === column.sortKey;
              return (
                <TableHead key={column.id} className={cn("h-10 whitespace-nowrap", column.headerClassName)}>
                  {column.sortKey && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.sortKey ?? "")}
                      className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Sort by ${typeof column.header === "string" ? column.header : column.sortKey}`}
                    >
                      {column.header}
                      {active ? (
                        sortDescending ? (
                          <ArrowDown className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowUp className="size-3.5" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="size-3.5 text-muted-foreground/60" aria-hidden />
                      )}
                    </button>
                  ) : (
                    column.header
                  )}
                </TableHead>
              );
            })}
          </TableRow>
        </TableHeader>
        <TableBody>
          {error ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="py-10">
                <div className="flex flex-col items-center gap-2 text-center">
                  <TriangleAlert className="size-5 text-destructive" aria-hidden />
                  <p className="text-sm font-medium">Could not load data</p>
                  <p className="max-w-md text-sm text-muted-foreground">
                    {error instanceof Error ? error.message : "Unexpected error"}
                  </p>
                  {onRetry ? (
                    <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                      Try again
                    </Button>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          ) : isLoading ? (
            Array.from({ length: loadingRows }).map((_, index) => (
              <TableRow key={`loading-${index}`} className="hover:bg-transparent">
                {columns.map((column) => (
                  <TableCell key={column.id} className={column.className}>
                    <div className="h-4 w-full max-w-32 animate-pulse rounded bg-muted" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="p-0">
                {empty ?? <EmptyState title="Nothing here yet" />}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                className={cn(onRowClick && "cursor-pointer")}
              >
                {columns.map((column) => (
                  <TableCell key={column.id} className={column.className}>
                    {column.cell(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {isLoading && rows.length > 0 ? (
        <div className="flex items-center justify-center gap-2 border-t py-2 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" aria-hidden /> Refreshing
        </div>
      ) : null}
    </div>
  );
}
