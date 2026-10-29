import {
  Button,
  Pagination,
  PaginationContent,
  PaginationItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@orbitid/ui";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { formatNumber } from "../../lib/format";

const PAGE_SIZES = [10, 20, 50, 100];

function pageWindow(page: number, totalPages: number): (number | "ellipsis")[] {
  if (totalPages <= 7) return Array.from({ length: totalPages }, (_, index) => index + 1);
  const pages = new Set<number>([1, totalPages, page, page - 1, page + 1]);
  const sorted = [...pages].filter((value) => value >= 1 && value <= totalPages).sort((a, b) => a - b);
  const result: (number | "ellipsis")[] = [];
  sorted.forEach((value, index) => {
    const previous = sorted[index - 1];
    if (previous !== undefined && value - previous > 1) result.push("ellipsis");
    result.push(value);
  });
  return result;
}

export function TablePagination({
  page,
  limit,
  total,
  onPageChange,
  onLimitChange,
  disabled,
}: {
  page: number;
  limit: number;
  total: number;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  disabled?: boolean;
}) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const currentPage = Math.min(page, totalPages);
  const start = total === 0 ? 0 : (currentPage - 1) * limit + 1;
  const end = Math.min(currentPage * limit, total);

  return (
    <div className="flex flex-col-reverse items-center justify-between gap-3 sm:flex-row">
      <p className="text-xs text-muted-foreground tabular-nums">
        {total === 0 ? "No results" : `Showing ${formatNumber(start)}–${formatNumber(end)} of ${formatNumber(total)}`}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-3">
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Rows</span>
          <Select value={String(limit)} onValueChange={(value) => onLimitChange(Number(value))} disabled={disabled}>
            <SelectTrigger className="h-7 w-[68px] text-xs" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Pagination className="mx-0 w-auto justify-start">
          <PaginationContent className="gap-1">
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                aria-label="Previous page"
                disabled={disabled || currentPage <= 1}
                onClick={() => onPageChange(currentPage - 1)}
              >
                <ChevronLeft aria-hidden />
              </Button>
            </PaginationItem>
            {pageWindow(currentPage, totalPages).map((entry, index) =>
              entry === "ellipsis" ? (
                <PaginationItem key={`ellipsis-${index}`}>
                  <span className="px-1 text-xs text-muted-foreground" aria-hidden>
                    …
                  </span>
                </PaginationItem>
              ) : (
                <PaginationItem key={entry}>
                  <Button
                    type="button"
                    variant={entry === currentPage ? "default" : "outline"}
                    size="icon"
                    className="size-7 text-xs tabular-nums"
                    aria-label={`Page ${entry}`}
                    aria-current={entry === currentPage ? "page" : undefined}
                    disabled={disabled}
                    onClick={() => onPageChange(entry)}
                  >
                    {entry}
                  </Button>
                </PaginationItem>
              ),
            )}
            <PaginationItem>
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-7"
                aria-label="Next page"
                disabled={disabled || currentPage >= totalPages}
                onClick={() => onPageChange(currentPage + 1)}
              >
                <ChevronRight aria-hidden />
              </Button>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}
