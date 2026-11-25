import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { InstanceSettings, RoleJSON } from "@orbitid/shared";
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { SETTINGS_QUERY_KEY } from "../_config/data";
import { errorMessage } from "../_config/settings";
import { normalizeInstanceSettings } from "../_config/settings/patch";
import { Field } from "../_config/ui";

/** Select value for "no default role"; role keys always contain a colon, so it cannot collide. */
const NONE = "none";

/** Custom instance roles a user may inherit. `app:sys_*` roles open the console and are never a default. */
export function defaultRoleOptions(roles: RoleJSON[]): RoleJSON[] {
  return roles.filter((role) => role.key.startsWith("app:") && !role.key.startsWith("app:sys_"));
}

/**
 * Instance default role (`roles.defaultRole`). Saved on its own, not through the page's SaveBar: it changes the
 * effective roles of every user without an assignment at their next token, so it is an explicit action.
 */
export function DefaultRoleField({ roles, current, loading }: { roles: RoleJSON[]; current: string | null; loading: boolean }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(current ?? NONE);
  const [saving, setSaving] = useState(false);
  useEffect(() => { setValue(current ?? NONE); }, [current]);
  const options = defaultRoleOptions(roles);
  const missing = current !== null && !loading && !options.some((role) => role.key === current);
  const next = value === NONE ? null : value;

  const save = async () => {
    setSaving(true);
    try {
      const response = await api<unknown>("PATCH", "/instance", { roles: { defaultRole: next } });
      queryClient.setQueryData<InstanceSettings>(SETTINGS_QUERY_KEY, normalizeInstanceSettings(response));
      // Effective roles of every inheriting user just changed.
      void queryClient.invalidateQueries({ queryKey: ["user"] });
      void queryClient.invalidateQueries({ queryKey: ["users"] });
      toast.success(next ? `Default role set to ${next}` : "Default role removed");
    } catch (error) {
      toast.error("Could not save the default role", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[16rem] flex-1 sm:max-w-sm">
          <Field label="Default role" htmlFor="default-instance-role">
            <Select value={value} onValueChange={setValue} disabled={saving || loading}>
              <SelectTrigger id="default-instance-role" className="w-full">
                <SelectValue placeholder="No default role" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No default role</SelectItem>
                {options.map((role) => (
                  <SelectItem key={role.id} value={role.key}>
                    {role.name} <span className="text-muted-foreground">({role.key})</span>
                  </SelectItem>
                ))}
                {missing ? <SelectItem value={current}>{current} (missing)</SelectItem> : null}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <Button size="sm" variant="outline" disabled={saving || next === current} onClick={() => void save()}>
          {saving ? "Saving…" : "Save default"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Every user without assigned instance roles holds this role. Assigning roles to a user replaces it. Guest accounts never inherit it.
      </p>
      {missing ? <p className="text-xs text-destructive">{current} no longer exists, so it grants nothing. Choose another default or none.</p> : null}
    </div>
  );
}
