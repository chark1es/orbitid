import { useRef, useState } from "react";
import type { JwtTemplateJSON, PaginatedList } from "@orbitid/shared";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orbitid/ui";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "../lib/api";
import { unwrapList } from "./_config/data";
import {
  SESSION_SHORTCODES,
  SAMPLE_TEMPLATE_CONTEXT,
  errorMessage,
  formatDate,
  formatJson,
  insertAtCursor,
  parseJsonRecord,
  previewTemplateClaims,
  reservedJwtClaimErrors,
} from "./_config/settings";
import {
  ConfirmDialog,
  EmptyState,
  ErrorAlert,
  Field,
  JsonEditor,
  LoadingPage,
  PageHeader,
  SectionCard,
  SwitchRow,
  TableSkeleton,
} from "./_config/ui";

interface TemplateForm {
  id?: string;
  name: string;
  claimsText: string;
  lifetime: string;
  allowedClockSkew: string;
  signingAlgorithm: string;
  customSigningKey: boolean;
}

const EMPTY_FORM: TemplateForm = {
  name: "",
  claimsText: formatJson({ email: "{{user.primary_email_address}}", org: "{{org.slug}}" }),
  lifetime: "60",
  allowedClockSkew: "5",
  signingAlgorithm: "RS256",
  customSigningKey: false,
};

const ALGORITHMS = ["RS256", "ES256", "HS256"];

export default function Page() {
  const query = useApi<PaginatedList<JwtTemplateJSON>>(["jwt_templates"], "/jwt_templates?limit=100");
  const templates = unwrapList<JwtTemplateJSON>(query.data);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [form, setForm] = useState<TemplateForm>(EMPTY_FORM);
  const [claimsError, setClaimsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<JwtTemplateJSON | null>(null);
  const [deleting, setDeleting] = useState(false);
  const claimsRef = useRef<HTMLTextAreaElement>(null);

  const parsedClaims = parseJsonRecord(form.claimsText);

  const openCreate = () => {
    setForm({ ...EMPTY_FORM, claimsText: formatJson({}) });
    setClaimsError(null);
    setSheetOpen(true);
  };

  const openEdit = (template: JwtTemplateJSON) => {
    setForm({
      id: template.id,
      name: template.name,
      claimsText: formatJson(template.claims),
      lifetime: String(template.lifetime),
      allowedClockSkew: String(template.allowed_clock_skew),
      signingAlgorithm: template.signing_algorithm || "RS256",
      customSigningKey: template.custom_signing_key,
    });
    setClaimsError(null);
    setSheetOpen(true);
  };

  const updateClaims = (text: string) => {
    setForm((current) => ({ ...current, claimsText: text }));
    const parsed = parseJsonRecord(text);
    setClaimsError(parsed.error);
  };

  const insertShortcode = (shortcode: string) => {
    const next = insertAtCursor(
      form.claimsText,
      shortcode,
      claimsRef.current?.selectionStart ?? null,
      claimsRef.current?.selectionEnd ?? null,
    );
    updateClaims(next.value);
    requestAnimationFrame(() => {
      claimsRef.current?.focus();
      claimsRef.current?.setSelectionRange(next.caret, next.caret);
    });
  };

  const errors: string[] = [];
  if (!form.name.trim()) errors.push("Template name is required.");
  else if (!/^[a-zA-Z0-9_-]{1,64}$/.test(form.name.trim())) errors.push("Use letters, numbers, dashes or underscores in the template name.");
  if (!parsedClaims.value) errors.push(claimsError ?? "Claims must be a JSON object.");
  const lifetime = Number(form.lifetime);
  const skew = Number(form.allowedClockSkew);
  if (!Number.isFinite(lifetime) || lifetime < 30) errors.push("Token lifetime must be at least 30 seconds.");
  if (lifetime > 315_360_000) errors.push("Token lifetime cannot exceed 10 years.");
  if (!Number.isFinite(skew) || skew < 0) errors.push("Clock skew cannot be negative.");
  if (skew > 300) errors.push("Clock skew cannot exceed 300 seconds.");
  if (parsedClaims.value) errors.push(...reservedJwtClaimErrors(parsedClaims.value));
  if (templates.some((template) => template.name === form.name.trim() && template.id !== form.id)) errors.push("A template with this name already exists.");

  const preview = parsedClaims.value ? previewTemplateClaims(parsedClaims.value, SAMPLE_TEMPLATE_CONTEXT) : null;

  const saveTemplate = async () => {
    if (errors.length > 0 || !parsedClaims.value) return;
    setSaving(true);
    try {
      const body = {
        name: form.name.trim(),
        claims: parsedClaims.value,
        lifetime,
        allowed_clock_skew: skew,
        signing_algorithm: form.signingAlgorithm,
        custom_signing_key: form.customSigningKey,
      };
      if (form.id) await api("PATCH", `/jwt_templates/${form.id}`, body);
      else await api("POST", "/jwt_templates", body);
      await query.refetch();
      toast.success(form.id ? "JWT template updated" : "JWT template created");
      setSheetOpen(false);
    } catch (error) {
      toast.error("Could not save JWT template", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const deleteTemplate = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api("DELETE", `/jwt_templates/${selected.id}`);
      await query.refetch();
      toast.success("JWT template deleted");
      setSelected(null);
    } catch (error) {
      toast.error("Could not delete JWT template", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="JWT templates"
        description="Named claim sets that can be requested with `getToken({ template })`. Session tokens keep the default lifetime unless a template overrides it."
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> New template
          </Button>
        }
      />

      <SectionCard title="Templates" description="Every template is available by name to the Frontend API token endpoints.">
        {query.isLoading ? (
          <TableSkeleton />
        ) : query.error ? (
          <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} />
        ) : templates.length === 0 ? (
          <EmptyState
            title="No JWT templates"
            description="Create a template to add custom claims to session tokens for a specific integration."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" /> New template
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Lifetime</TableHead>
                  <TableHead>Clock skew</TableHead>
                  <TableHead>Algorithm</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {templates.map((template) => (
                  <TableRow key={template.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <code className="text-xs font-medium">{template.name}</code>
                        {template.custom_signing_key ? <Badge variant="outline">Custom key</Badge> : null}
                      </div>
                    </TableCell>
                    <TableCell>{template.lifetime}s</TableCell>
                    <TableCell>{template.allowed_clock_skew}s</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{template.signing_algorithm}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(template.updated_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(template)} title="Edit">
                          <Pencil className="size-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(template)} title="Delete">
                          <Trash2 className="size-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-2xl">
          <SheetHeader>
            <SheetTitle>{form.id ? "Edit JWT template" : "New JWT template"}</SheetTitle>
            <SheetDescription>
              Claims are rendered per user, session, and active organization. Whole-value shortcodes keep their JSON type.
            </SheetDescription>
          </SheetHeader>
          <div className="space-y-4 px-4 pb-2">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Name" htmlFor="template-name" required description={'Used in getToken({ template: "name" }).'}>
                <Input
                  id="template-name"
                  value={form.name}
                  onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
                  placeholder="hasura"
                />
              </Field>
              <Field label="Signing algorithm" htmlFor="template-algorithm">
                <Select
                  value={form.signingAlgorithm}
                  onValueChange={(signingAlgorithm) => setForm((current) => ({ ...current, signingAlgorithm }))}
                >
                  <SelectTrigger id="template-algorithm" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ALGORITHMS.map((algorithm) => (
                      <SelectItem key={algorithm} value={algorithm}>
                        {algorithm}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Lifetime (seconds)" htmlFor="template-lifetime">
                <Input
                  id="template-lifetime"
                  type="number"
                  min={30}
                  value={form.lifetime}
                  onChange={(event) => setForm((current) => ({ ...current, lifetime: event.target.value }))}
                />
              </Field>
              <Field label="Allowed clock skew (seconds)" htmlFor="template-skew">
                <Input
                  id="template-skew"
                  type="number"
                  min={0}
                  max={300}
                  value={form.allowedClockSkew}
                  onChange={(event) => setForm((current) => ({ ...current, allowedClockSkew: event.target.value }))}
                />
              </Field>
            </div>
            <SwitchRow
              label="Use custom signing key"
              description="Sign tokens for this template with a dedicated key instead of the instance key."
              checked={form.customSigningKey}
              onCheckedChange={(customSigningKey) => setForm((current) => ({ ...current, customSigningKey }))}
            />
            <Field label="Claims (JSON)" required>
              <JsonEditor ref={claimsRef} value={form.claimsText} onChange={updateClaims} error={claimsError} rows={12} />
            </Field>
            <Accordion type="single" collapsible>
              <AccordionItem value="shortcodes">
                <AccordionTrigger className="text-sm">Shortcode reference — click to insert</AccordionTrigger>
                <AccordionContent>
                  <div className="grid gap-1.5 sm:grid-cols-2">
                    {SESSION_SHORTCODES.map((item) => (
                      <button
                        key={item.code}
                        type="button"
                        onClick={() => insertShortcode(item.code)}
                        className="flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
                      >
                        <code className="font-mono">{item.code}</code>
                        <span className="truncate text-muted-foreground">{item.description}</span>
                      </button>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Rendered preview</p>
                <Badge variant="outline">Sample user</Badge>
              </div>
              <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
                {preview === null ? "Fix the claims JSON to see a preview." : JSON.stringify(preview, null, 2)}
              </pre>
              <p className="text-xs text-muted-foreground">
                Preview is interpolated locally with Ada Lovelace / Acme Inc. Reserved JWT claims (iss, sub, sid, iat, exp) are added by the server.
              </p>
            </div>
            {errors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {errors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <SheetFooter>
            <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveTemplate()} disabled={saving || errors.length > 0}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Create template"}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Delete JWT template?"
        description={
          <span>
            Tokens requested with <code>{selected?.name}</code> will fail until a template with that name exists again.
          </span>
        }
        confirmLabel="Delete template"
        destructive
        loading={deleting}
        onConfirm={() => void deleteTemplate()}
      />
    </div>
  );
}
