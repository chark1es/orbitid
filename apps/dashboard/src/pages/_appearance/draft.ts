import { contrast, flat, soft, type AppearanceVariables, type BaseTheme } from "@orbitid/react";

/** The prebuilt-component presets the playground offers, by the name the snippet imports. */
export const PRESETS: Record<PresetName, BaseTheme | null> = { default: null, soft, contrast, flat };
export type PresetName = "default" | "soft" | "contrast" | "flat";

export const FONTS = {
  default: { label: "Hanken Grotesk (default)", value: "" },
  system: { label: "System UI", value: "ui-sans-serif, system-ui, sans-serif" },
  serif: { label: "Serif", value: "ui-serif, Georgia, serif" },
  rounded: { label: "Rounded", value: "ui-rounded, 'SF Pro Rounded', 'Hanken Grotesk Variable', sans-serif" },
} as const;
export type FontName = keyof typeof FONTS;

/** Local-only playground state. It never reaches the instance: the operator copies the snippet into the app. */
export interface AppearanceDraft {
  preset: PresetName;
  borderRadius: string;
  font: FontName;
  fontSize: string;
  spacingUnit: string;
  shadowStrength: string;
  colorBackground: string;
}

export const DEFAULT_DRAFT: AppearanceDraft = {
  preset: "default",
  borderRadius: "",
  font: "default",
  fontSize: "",
  spacingUnit: "",
  shadowStrength: "",
  colorBackground: "",
};

/** Only the values the operator changed, so the snippet stays short and the defaults keep following releases. */
export function draftVariables(draft: AppearanceDraft, primaryColor?: string): AppearanceVariables {
  const variables: AppearanceVariables = {};
  if (primaryColor) variables.colorPrimary = primaryColor;
  if (draft.colorBackground) variables.colorBackground = draft.colorBackground;
  if (draft.borderRadius) variables.borderRadius = draft.borderRadius;
  if (FONTS[draft.font].value) variables.fontFamily = FONTS[draft.font].value;
  if (draft.fontSize) variables.fontSize = draft.fontSize;
  if (draft.spacingUnit) variables.spacingUnit = draft.spacingUnit;
  if (draft.shadowStrength) variables.shadowStrength = Number(draft.shadowStrength);
  return variables;
}

/** The `appearance` prop for the draft, as TypeScript an app can paste. The primary color comes from branding. */
export function appearanceSnippet(draft: AppearanceDraft): string {
  const variables = draftVariables(draft);
  const lines: string[] = [];
  if (draft.preset !== "default") lines.push(`  baseTheme: ${draft.preset},`);
  const entries = Object.entries(variables);
  if (entries.length > 0) {
    lines.push("  variables: {");
    for (const [key, value] of entries) lines.push(`    ${key}: ${typeof value === "number" ? value : JSON.stringify(value)},`);
    lines.push("  },");
  }
  const imports = draft.preset !== "default" ? `import { ${draft.preset} } from "@orbitid/react";\n\n` : "";
  if (lines.length === 0) return `${imports}// Defaults: nothing to configure.\nconst appearance = {};`;
  return `${imports}const appearance = {\n${lines.join("\n")}\n};`;
}
