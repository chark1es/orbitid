import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@orbitid/ui";
import { CopyButton, Field } from "../_config/ui";
import { FONTS, appearanceSnippet, type AppearanceDraft, type FontName, type PresetName } from "./draft";

interface Choice {
  value: string;
  label: string;
}

/** Radix Select cannot hold an empty value, so "default" stands in for "not set". */
const DEFAULT = "default";

function ChoiceField({
  id,
  label,
  value,
  choices,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  choices: Choice[];
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} htmlFor={id}>
      <Select value={value || DEFAULT} onValueChange={(next) => onChange(next === DEFAULT ? "" : next)}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {choices.map((choice) => (
            <SelectItem key={choice.value || DEFAULT} value={choice.value || DEFAULT}>
              {choice.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/**
 * Variables the instance does not store: the operator tries them against the preview and copies the resulting
 * `appearance` into the app. Instance branding (primary color, theme) above is what every app gets by default.
 */
export function AppearancePlayground({
  draft,
  onChange,
}: {
  draft: AppearanceDraft;
  onChange: (patch: Partial<AppearanceDraft>) => void;
}) {
  const snippet = appearanceSnippet(draft);
  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <ChoiceField
          id="appearance-preset"
          label="Base theme"
          value={draft.preset === "default" ? "" : draft.preset}
          onChange={(preset) => onChange({ preset: (preset || "default") as PresetName })}
          choices={[
            { value: "", label: "Default" },
            { value: "soft", label: "Soft" },
            { value: "contrast", label: "High contrast" },
            { value: "flat", label: "Flat" },
          ]}
        />
        <ChoiceField
          id="appearance-radius"
          label="Corner radius"
          value={draft.borderRadius}
          onChange={(borderRadius) => onChange({ borderRadius })}
          choices={[
            { value: "", label: "Theme default" },
            { value: "0", label: "Square" },
            { value: "0.25rem", label: "Small (4px)" },
            { value: "0.5rem", label: "Medium (8px)" },
            { value: "0.75rem", label: "Large (12px)" },
            { value: "1rem", label: "Extra large (16px)" },
          ]}
        />
        <ChoiceField
          id="appearance-font"
          label="Font"
          value={draft.font === "default" ? "" : draft.font}
          onChange={(font) => onChange({ font: (font || "default") as FontName })}
          choices={Object.entries(FONTS).map(([value, font]) => ({ value: value === "default" ? "" : value, label: font.label }))}
        />
        <ChoiceField
          id="appearance-font-size"
          label="Text size"
          value={draft.fontSize}
          onChange={(fontSize) => onChange({ fontSize })}
          choices={[
            { value: "13px", label: "Compact (13px)" },
            { value: "", label: "Default (14px)" },
            { value: "15px", label: "Comfortable (15px)" },
            { value: "16px", label: "Large (16px)" },
          ]}
        />
        <ChoiceField
          id="appearance-spacing"
          label="Spacing"
          value={draft.spacingUnit}
          onChange={(spacingUnit) => onChange({ spacingUnit })}
          choices={[
            { value: "0.22rem", label: "Tight" },
            { value: "", label: "Default" },
            { value: "0.28rem", label: "Roomy" },
          ]}
        />
        <ChoiceField
          id="appearance-shadow"
          label="Shadows"
          value={draft.shadowStrength}
          onChange={(shadowStrength) => onChange({ shadowStrength })}
          choices={[
            { value: "0", label: "None" },
            { value: "0.5", label: "Subtle" },
            { value: "", label: "Default" },
            { value: "1.6", label: "Pronounced" },
          ]}
        />
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-rail">
        <div className="flex items-center justify-between gap-2 border-b border-white/10 py-1 ps-3 pe-1">
          <p className="font-data text-[0.6875rem] text-rail-muted">appearance for your app</p>
          <CopyButton value={snippet} label="Copy" size="sm" className="text-rail-foreground hover:bg-white/10 hover:text-rail-foreground" />
        </div>
        <pre data-testid="appearance-snippet" className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6 text-rail-foreground">
          {snippet}
        </pre>
      </div>
    </div>
  );
}
