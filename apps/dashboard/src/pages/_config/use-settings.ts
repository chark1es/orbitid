import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { InstanceSettings } from "@orbitid/shared";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { SETTINGS_QUERY_KEY, fetchInstanceSettings } from "./data";
import {
  buildSettingsPatch,
  cloneJson,
  deepMerge,
  errorMessage,
  hasPatch,
  mergeSettingsResponse,
  type DeepPatch,
} from "./settings";

export interface SettingsEditor {
  settings: InstanceSettings | null;
  draft: InstanceSettings | null;
  baseline: InstanceSettings | null;
  dirty: boolean;
  revision: number;
  isLoading: boolean;
  error: string | null;
  saveError: string | null;
  saving: boolean;
  patch: (partial: DeepPatch) => void;
  update: (updater: (current: InstanceSettings) => InstanceSettings) => void;
  reset: () => void;
  save: () => Promise<boolean>;
  refetch: () => void;
}

/**
 * Single-owner editor for `GET/PATCH /instance`.
 * Mutations are applied to a local draft immediately (optimistic UX); the sticky SaveBar persists only
 * changed paths and never overwrites a stored secret with a blank/masked form value.
 */
export function useSettingsEditor(): SettingsEditor {
  const queryClient = useQueryClient();
  const query = useQuery<InstanceSettings>({
    queryKey: SETTINGS_QUERY_KEY,
    queryFn: fetchInstanceSettings,
    staleTime: 15_000,
  });
  const [draft, setDraft] = useState<InstanceSettings | null>(null);
  const [baseline, setBaseline] = useState<InstanceSettings | null>(null);
  const [revision, setRevision] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    if (!query.data || initialized.current) return;
    initialized.current = true;
    const loaded = cloneJson(query.data);
    setDraft(loaded);
    setBaseline(cloneJson(query.data));
    setRevision((value) => value + 1);
  }, [query.data]);

  const dirty = useMemo(() => {
    if (!draft || !baseline) return false;
    return JSON.stringify(draft) !== JSON.stringify(baseline);
  }, [draft, baseline]);

  const patch = useCallback((partial: DeepPatch) => {
    setSaveError(null);
    setDraft((current) => (current ? deepMerge(current, partial) : current));
  }, []);

  const update = useCallback((updater: (current: InstanceSettings) => InstanceSettings) => {
    setSaveError(null);
    setDraft((current) => (current ? updater(current) : current));
  }, []);

  const reset = useCallback(() => {
    setDraft((current) => {
      if (baseline) return cloneJson(baseline);
      return current;
    });
    setSaveError(null);
    setRevision((value) => value + 1);
  }, [baseline]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft || !baseline || saving) return false;
    const body = buildSettingsPatch(baseline, draft);
    if (!hasPatch(body)) {
      toast.info("No changes to save");
      return true;
    }
    setSaving(true);
    setSaveError(null);
    try {
      const response = await api<unknown>("PATCH", "/instance", body);
      const fallback = deepMerge(cloneJson(baseline), body);
      const next = mergeSettingsResponse(response, fallback);
      queryClient.setQueryData(SETTINGS_QUERY_KEY, next);
      setBaseline(cloneJson(next));
      setDraft(cloneJson(next));
      setRevision((value) => value + 1);
      toast.success("Settings saved");
      return true;
    } catch (error) {
      setSaveError(errorMessage(error));
      return false;
    } finally {
      setSaving(false);
    }
  }, [baseline, draft, queryClient, saving]);

  return {
    settings: draft,
    draft,
    baseline,
    dirty,
    revision,
    isLoading: query.isLoading,
    error: query.error ? errorMessage(query.error) : null,
    saveError,
    saving,
    patch,
    update,
    reset,
    save,
    refetch: () => {
      void query.refetch();
    },
  };
}
