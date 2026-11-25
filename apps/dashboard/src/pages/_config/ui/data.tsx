import * as React from "react";
import {
  Button,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Textarea,
  cn,
  useMediaQuery,
} from "@orbitid/ui";
import { Plus, X } from "lucide-react";
import { CopyButton } from "./clipboard";

type TablePart = React.ComponentType<{ children?: React.ReactNode; className?: string }>;

type NodeElement = React.ReactElement<{ children?: React.ReactNode }>;

function childElements(node: React.ReactNode): NodeElement[] {
  return React.Children.toArray(node).filter(React.isValidElement) as NodeElement[];
}

function findPart(node: React.ReactNode, part: TablePart): NodeElement | null {
  for (const child of childElements(node)) {
    if (child.type === part) return child;
    const nested = findPart(child.props.children, part);
    if (nested) return nested;
  }
  return null;
}

function plainText(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(plainText).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) return plainText(node.props.children);
  return "";
}

/**
 * The stacked layout is not a table: a `<TableCell>` element cannot render inside a `<div>`/`<dd>`
 * (React rejects `<td>` there). Unwrap the cell into a plain `<div>` that carries its class names
 * and children, so page-level sizing such as `max-w-[26rem]` still applies to the stacked row.
 */
function stackedCell(cell: React.ReactElement<{ children?: React.ReactNode; className?: string }>): React.ReactNode {
  if (cell.type !== TableCell) return cell;
  return <div className={cn("min-w-0", cell.props.className)}>{cell.props.children}</div>;
}

interface StackedCell {
  cell: React.ReactElement<{ children?: React.ReactNode; colSpan?: number }>;
  label: string;
}

function stackedRows(children: React.ReactNode): { primary: StackedCell; action: StackedCell | null; fields: StackedCell[]; full: React.ReactNode | null }[] {
  const header = findPart(children, TableHeader);
  const body = findPart(children, TableBody);
  if (!body) return [];
  const headerRow = header ? childElements(header.props.children)[0] : null;
  const labels = headerRow ? childElements(headerRow.props.children).map((head) => plainText(head.props.children).trim()) : [];
  const actionIndex = labels.findIndex((label) => label.toLowerCase() === "actions");

  return childElements(body.props.children).map((row) => {
    const cells = childElements(row.props.children) as StackedCell["cell"][];
    const labelled = cells.map((cell, index) => ({ cell, label: labels[index] ?? "" }));
    if (cells.length === 1 && (cells[0].props.colSpan ?? 1) > 1) {
      return { primary: labelled[0], action: null, fields: [], full: cells[0].props.children };
    }
    const action = actionIndex >= 0 ? labelled[actionIndex] ?? null : null;
    const fields = labelled.filter((_entry, index) => index !== 0 && index !== actionIndex);
    return { primary: labelled[0], action, fields, full: null };
  });
}

/**
 * Table frame with the shared row height, rule, and column header treatment. Below 640px the table becomes
 * labelled stacked rows, like DataTable, so an actions column never sits off-screen.
 */
export function RuledTable({ children, className }: { children: React.ReactNode; className?: string }) {
  const stacked = useMediaQuery("(max-width: 639px)");

  if (stacked) {
    return (
      <div className={cn("w-full border-y border-border", className)} data-slot="ruled-table-stack">
        <ul className="divide-y divide-border">
          {stackedRows(children).map((row, index) => (
            <li key={index} className="min-w-0 px-3 py-3">
              {row.full !== null ? (
                row.full
              ) : (
                <>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1 break-words">{stackedCell(row.primary.cell)}</div>
                    {row.action ? <div className="shrink-0">{stackedCell(row.action.cell)}</div> : null}
                  </div>
                  {row.fields.length > 0 ? (
                    <dl className="mt-2.5 grid grid-cols-[minmax(0,1fr)] gap-1 border-t border-border pt-2">
                      {row.fields.map((field, fieldIndex) => (
                        <div key={fieldIndex} className="flex min-w-0 items-baseline justify-between gap-4">
                          <dt className="text-[0.6875rem] font-medium text-muted-foreground">
                            {field.label}
                          </dt>
                          <dd className="min-w-0 overflow-hidden text-right break-words [&_.font-data]:break-all [&_span]:align-baseline">{stackedCell(field.cell)}</dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div className={cn("w-full border-y border-border", className)}>
      <Table
        className={cn(
          "[&_thead_tr]:border-border [&_thead_tr:hover]:bg-transparent",
          "[&_th]:h-9 [&_th]:text-[0.75rem] [&_th]:font-medium [&_th]:text-muted-foreground",
          "[&_td]:h-10 [&_td]:py-0 [&_tbody_tr]:border-border [&_tbody_tr:hover]:bg-muted/40",
        )}
      >
        {children}
      </Table>
    </div>
  );
}

export interface JsonEditorProps extends Omit<React.TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
}

export const JsonEditor = React.forwardRef<HTMLTextAreaElement, JsonEditorProps>(function JsonEditor(
  { value, onChange, error, className, rows = 12, ...props },
  ref,
) {
  return (
    <div className="space-y-1.5">
      <Textarea
        ref={ref}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        rows={rows}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn("min-h-40 font-data text-xs leading-relaxed", error && "border-destructive", className)}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${props.id ?? "json"}-error` : undefined}
        {...props}
      />
      {error ? (
        <p id={`${props.id ?? "json"}-error`} className="text-xs font-medium text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
});

export function StringListEditor({
  values,
  onChange,
  placeholder = "https://example.com",
  addLabel = "Add item",
  emptyLabel = "No items yet.",
  inputType = "url",
}: {
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  addLabel?: string;
  emptyLabel?: string;
  inputType?: React.HTMLInputTypeAttribute;
}) {
  const update = (index: number, value: string) => {
    const next = [...values];
    next[index] = value;
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {values.length === 0 ? <p className="text-xs text-muted-foreground">{emptyLabel}</p> : null}
      {values.map((value, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            type={inputType}
            value={value}
            placeholder={placeholder}
            onChange={(event) => update(index, event.target.value)}
            className="font-data text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
            title="Remove">
            <X className="size-4" aria-hidden />
            <span className="sr-only">Remove</span>
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange([...values, ""])}>
        <Plus className="size-4" aria-hidden />
        {addLabel}
      </Button>
    </div>
  );
}

export function EndpointRow({ label, description, url }: { label: string; description?: string; url: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-border py-2 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <p className="text-[0.8125rem] font-medium">{label}</p>
        <code className="block truncate font-data text-xs text-muted-foreground">{url}</code>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <CopyButton value={url} size="icon-sm" variant="outline" />
    </div>
  );
}

export { StatusBadge } from "../../../components/shared/status-badge";
