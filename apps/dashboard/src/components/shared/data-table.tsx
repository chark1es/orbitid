import type { ReactNode } from "react";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
} from "@orbitid/ui";
import { ArrowDown, ArrowUp, ArrowUpDown, TriangleAlert } from "lucide-react";
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

/**
 * Dense data table: 40px rows, one rule between rows, a rule under the header, no zebra.
 * `onRowClick` is a mouse convenience; the row's own link carries the same destination for the keyboard.
 */
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
    <div className={cn("overflow-hidden rounded-[4px] border border-border", className)}>
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column) => {
              const active = !!column.sortKey && sortKey === column.sortKey;
              return (
                <TableHead
                  key={column.id}
                  aria-sort={column.sortKey && onSort ? (active ? (sortDescending ? "descending" : "ascending") : "none") : undefined}
                  className={cn(
                    "h-9 whitespace-nowrap text-[0.75rem] font-semibold uppercase tracking-[0.04em] text-muted-foreground",
                    column.headerClassName,
                  )}
                >
                  {column.sortKey && onSort ? (
                    <button
                      type="button"
                      onClick={() => onSort(column.sortKey ?? "")}
                      className="-ml-1 inline-flex items-center gap-1 rounded-[3px] px-1 py-0.5 uppercase tracking-[0.04em] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label={`Sort by ${typeof column.header === "string" ? column.header : column.sortKey}`}
                    >
                      {column.header}
                      {active ? (
                        sortDescending ? (
                          <ArrowDown className="size-3" aria-hidden />
                        ) : (
                          <ArrowUp className="size-3" aria-hidden />
                        )
                      ) : (
                        <ArrowUpDown className="size-3 text-muted-foreground/50" aria-hidden />
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
              <TableCell colSpan={columnCount} className="h-auto py-12">
                <div className="mx-auto flex max-w-md flex-col items-center gap-2 text-center">
                  <TriangleAlert className="size-5 text-signal" strokeWidth={1.5} aria-hidden />
                  <p className="text-sm font-medium">Could not load this list</p>
                  <p className="text-sm leading-6 text-muted-foreground">
                    {error instanceof Error ? error.message : "The request failed."} Check that the server is running at
                    the frontend API URL, then try again.
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
                  <TableCell key={column.id} className={cn("h-10 py-0", column.className)}>
                    <div className="h-2.5 w-full max-w-32 animate-pulse rounded-[2px] bg-muted" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="h-auto p-0">
                {empty ?? <EmptyState title="Nothing here yet" />}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row, index) => (
              <TableRow
                key={rowKey(row)}
                onClick={
                  onRowClick
                    ? (event) => {
                        const target = event.target as HTMLElement | null;
                        if (target?.closest("a,button,input,label,select,textarea")) return;
                        onRowClick(row);
                      }
                    : undefined
                }
                className={cn(onRowClick && "cursor-pointer")}
              >
                {columns.map((column) => (
                  <TableCell key={column.id} className={cn("h-10 py-0", column.className)}>
                    {column.cell(row, index)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      {isLoading && rows.length > 0 ? (
        <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
          <span className="size-1.5 rounded-full bg-caution" aria-hidden /> Refreshing
        </div>
      ) : null}
    </div>
  );
}
