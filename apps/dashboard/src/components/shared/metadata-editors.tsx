import { useEffect, useMemo, useState } from "react";
import { Button } from "@orbitid/ui";
import { Loader2, Save } from "lucide-react";
import { parseJsonObject, stringifyMetadata } from "../../lib/format";
import { JsonEditor } from "./json-editor";
import { Section } from "./section";

export interface MetadataField {
  key: string;
  label: string;
  description?: string;
  value: Record<string, unknown> | undefined;
}

/**
 * Public/private/unsafe metadata editors. Only changed keys are sent; the server deep-merges them, so
 * sending one key never clobbers nested data written by other tooling.
 */
export function MetadataEditors({
  title = "Metadata",
  description = "Metadata is merged server-side. Set a key to `null` to remove it.",
  fields,
  onSubmit,
  pending,
}: {
  title?: string;
  description?: string;
  fields: MetadataField[];
  onSubmit: (patch: Record<string, Record<string, unknown>>) => void;
  pending?: boolean;
}) {
  // Reset drafts when the server values change, not on every parent render (pages rebuild `fields`).
  const serverKey = JSON.stringify(fields.map((field) => [field.key, field.value ?? {}]));
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const field of fields) map[field.key] = stringifyMetadata(field.value);
    return map;
  }, [serverKey]);

  const [drafts, setDrafts] = useState<Record<string, string>>(initial);
  useEffect(() => setDrafts(initial), [initial]);

  const invalid = fields.filter((field) => !parseJsonObject(drafts[field.key] ?? "").ok);
  const changed = fields.flatMap((field) => {
    const draft = parseJsonObject(drafts[field.key] ?? "");
    if (!draft.ok) return [];
    const base = parseJsonObject(initial[field.key] ?? "");
    if (base.ok && JSON.stringify(base.value) === JSON.stringify(draft.value)) return [];
    return [{ key: field.key, value: draft.value }];
  });

  return (
    <Section title={title} description={description} className="border-t-0 pt-0">
      <div className="space-y-5">
        {fields.map((field, index) => (
          <JsonEditor
            key={field.key}
            id={`metadata-${field.key}`}
            label={field.label}
            description={field.description}
            value={drafts[field.key] ?? ""}
            onChange={(value) => setDrafts((current) => ({ ...current, [field.key]: value }))}
            rows={index === 0 ? 8 : 6}
          />
        ))}
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-xs text-muted-foreground">
            {invalid.length
              ? "Fix invalid JSON before saving."
              : changed.length
                ? `${changed.length} field${changed.length === 1 ? "" : "s"} changed`
                : "No changes"}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="outline" disabled={!changed.length || pending} onClick={() => setDrafts(initial)}>
              Reset
            </Button>
            <Button
              type="button"
              disabled={!changed.length || invalid.length > 0 || pending}
              onClick={() => {
                const patch: Record<string, Record<string, unknown>> = {};
                for (const entry of changed) patch[entry.key] = entry.value;
                onSubmit(patch);
              }}
            >
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : <Save aria-hidden />}
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </Section>
  );
}
