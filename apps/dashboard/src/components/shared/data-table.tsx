import { cloneElement, isValidElement, type ReactNode } from "react";
import {
  Button,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  cn,
  useMediaQuery,
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
 * A page can hand a column a cell that is a `<TableCell>` (some tables share cell markup with their
 * desktop row). The stacked layout is not a table, so unwrap it into a `<div>` carrying the cell's
 * class names and children: a `<td>` inside a `<div>`/`<dd>` is invalid HTML and React warns about it.
 */
export function stackedCell(node: ReactNode): ReactNode {
  if (!isValidElement<{ children?: ReactNode; className?: string }>(node) || node.type !== TableCell) return node;
  return <div className={cn("min-w-0", node.props.className)}>{node.props.children}</div>;
}

/** An empty list inside the table frame gets the compact measure: a table is not a whole page. */
function tableEmpty(node: ReactNode): ReactNode {
  if (isValidElement<{ variant?: "compact" | "full" }>(node) && node.type === EmptyState) {
    return cloneElement(node, { variant: "compact" });
  }
  return node;
}

/**
 * Where a column goes in the stacked rows below 640px. The first content column is the primary
 * block, an `actions` column sits at its right edge, and every other column becomes a labelled
 * field. Column visibility classes (`hidden md:table-cell`) only apply to the real table; the
 * stacked layout always shows the field so nothing disappears on a phone.
 */
function mobileRole<T>(column: DataTableColumn<T>, primaryId: string | undefined): "leading" | "primary" | "action" | "field" {
  if (column.id === "select") return "leading";
  if (column.id === "actions") return "action";
  if (column.id === primaryId) return "primary";
  return "field";
}

function fieldLabel<T>(column: DataTableColumn<T>): string {
  return typeof column.header === "string" ? column.header : column.id;
}

function sortLabel<T>(column: DataTableColumn<T>): string {
  return typeof column.header === "string" ? column.header : (column.sortKey ?? column.id);
}

/** Shared arrow for the table header and the compact stacked sort control. */
function SortIcon({ active, descending }: { active: boolean; descending?: boolean }) {
  if (!active) return <ArrowUpDown className="size-4 text-muted-foreground/50" aria-hidden />;
  return descending ? <ArrowDown className="size-4" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />;
}

/**
 * Dense data table: 40px rows, one rule between rows, a rule under the header, no zebra.
 * Below 640px the same columns become labelled stacked rows, so an actions column can never sit
 * off-screen. `onRowClick` is a mouse convenience; the row's own link carries the same destination
 * for the keyboard.
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
  const stacked = useMediaQuery("(max-width: 639px)");
  const columnCount = columns.length;
  const primaryId = columns.find((column) => column.id !== "select" && column.id !== "actions")?.id;
  const selectColumn = columns.find((column) => column.id === "select");
  const sortableColumns = onSort ? columns.filter((column) => !!column.sortKey) : [];

  const frame = "overflow-hidden rounded-[4px] border border-border";

  if (stacked) {
    const showToolbar = rows.length > 0 && (selectColumn || sortableColumns.length > 0);
    return (
      <div className={cn(frame, className)} aria-busy={isLoading || undefined}>
        {showToolbar ? (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border px-3 py-1.5">
            {selectColumn ? (
              <label className="flex items-center gap-2">
                {selectColumn.header}
                <span className="text-[0.6875rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                  Select all
                </span>
              </label>
            ) : null}
            {sortableColumns.length > 0 ? (
              <div className="ml-auto flex flex-wrap items-center gap-1">
                <span className="text-[0.6875rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                  Sort
                </span>
                <div role="group" aria-label="Sort columns" className="flex flex-wrap items-center gap-1">
                  {sortableColumns.map((column) => {
                    const active = column.sortKey === sortKey;
                    const direction = sortDescending ? "descending" : "ascending";
                    return (
                      <button
                        key={column.id}
                        type="button"
                        onClick={() => onSort?.(column.sortKey ?? "")}
                        aria-pressed={active}
                        aria-label={
                          active
                            ? `Sort by ${sortLabel(column)}, sorted ${direction}`
                            : `Sort by ${sortLabel(column)}`
                        }
                        className="inline-flex min-h-6 items-center gap-1 rounded-[3px] px-1 text-[0.6875rem] font-medium tracking-[0.04em] text-muted-foreground uppercase transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none aria-pressed:text-foreground"
                      >
                        {column.header}
                        <SortIcon active={active} descending={sortDescending} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <div className="flex flex-col items-center gap-2 px-6 py-12 text-center">
            <TriangleAlert className="size-4 text-signal" aria-hidden />
            <p className="text-sm font-medium">Could not load this list</p>
            <p className="text-sm leading-6 text-muted-foreground">
              {error instanceof Error ? error.message : "The request failed."} Check that the server is running at the
              frontend API URL, then try again.
            </p>
            {onRetry ? (
              <Button type="button" variant="outline" size="sm" onClick={onRetry}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : isLoading ? (
          <ul data-slot="data-table-stack" aria-busy="true" className="divide-y divide-border">
            {Array.from({ length: Math.min(loadingRows, 6) }).map((_, index) => (
              <li key={`loading-${index}`} className="space-y-2 px-3 py-3">
                <div className="h-3 w-2/3 animate-pulse rounded-[3px] bg-muted" />
                <div className="h-2.5 w-1/2 animate-pulse rounded-[3px] bg-muted" />
              </li>
            ))}
          </ul>
        ) : rows.length === 0 ? (
          <div data-slot="data-table-stack">{tableEmpty(empty) ?? <EmptyState variant="compact" title="Nothing here yet" />}</div>
        ) : (
          <ul data-slot="data-table-stack" className="divide-y divide-border">
            {rows.map((row, index) => {
              const grouped = columns.map((column) => ({
                column,
                role: mobileRole(column, primaryId),
              }));
              const leading = grouped.filter((entry) => entry.role === "leading");
              const primary = grouped.filter((entry) => entry.role === "primary");
              const fields = grouped.filter((entry) => entry.role === "field");
              const actions = grouped.filter((entry) => entry.role === "action");
              return (
                <li
                  key={rowKey(row)}
                  className={cn("min-w-0 px-3 py-3", onRowClick && "cursor-pointer")}
                  onClick={
                    onRowClick
                      ? (event) => {
                          const target = event.target as HTMLElement | null;
                          if (target?.closest("a,button,input,label,select,textarea")) return;
                          onRowClick(row);
                        }
                      : undefined
                  }
                >
                  <div className="flex items-start gap-2">
                    {leading.map(({ column }) => (
                      <div key={column.id} className="pt-0.5">
                        {stackedCell(column.cell(row, index))}
                      </div>
                    ))}
                    <div className="min-w-0 flex-1 space-y-1 break-words">
                      {primary.map(({ column }) => (
                        <div key={column.id}>{stackedCell(column.cell(row, index))}</div>
                      ))}
                    </div>
                    {actions.map(({ column }) => (
                      <div key={column.id} className="shrink-0">
                        {stackedCell(column.cell(row, index))}
                      </div>
                    ))}
                  </div>
                  {fields.length > 0 ? (
                    // One explicit minmax track: an implicit auto column is sized by its content, so a
                    // 200-character value would make the whole card wider than the phone.
                    <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-border pt-2">
                      {fields.map(({ column }) => (
                        <div key={column.id} className="flex min-w-0 items-baseline justify-between gap-4">
                          <dt className="text-[0.6875rem] font-medium tracking-[0.04em] text-muted-foreground uppercase">
                            {fieldLabel(column)}
                          </dt>
                          <dd className="min-w-0 overflow-hidden text-right break-words [&_.font-data]:break-all [&_span]:align-baseline">{stackedCell(column.cell(row, index))}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {isLoading && rows.length > 0 ? (
          <div className="flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
            <span className="size-1.5 rounded-full bg-caution" aria-hidden /> Refreshing
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className={cn(frame, className)} aria-busy={isLoading || undefined}>
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
                      className="-ml-1 inline-flex items-center gap-1 rounded-[3px] px-1 py-0.5 leading-none control-optical uppercase tracking-[0.04em] transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                      aria-label={`Sort by ${sortLabel(column)}`}
                    >
                      {column.header}
                      <SortIcon active={active} descending={sortDescending} />
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
                  <TriangleAlert className="size-4 text-signal" aria-hidden />
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
                    <div className="h-2.5 w-full max-w-32 animate-pulse rounded-[3px] bg-muted" />
                  </TableCell>
                ))}
              </TableRow>
            ))
          ) : rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={columnCount} className="h-auto p-0">
                {tableEmpty(empty) ?? <EmptyState variant="compact" title="Nothing here yet" />}
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
