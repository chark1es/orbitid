/** Extra class names accepted by `cn`; kept free of a direct `clsx` dependency. */
export type ClassValue = string | false | null | undefined;

/**
 * Themeable design tokens. Mapped onto the shadcn/ui CSS variables rendered by
 * `@orbitid/ui/styles.css` (see `cssVariablesFrom`), plus `--orbitid-*` aliases for
 * component-local use.
 */
export interface AppearanceVariables {
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  colorTextSecondary?: string;
  colorDanger?: string;
  colorSuccess?: string;
  colorWarning?: string;
  colorNeutral?: string;
  colorBorder?: string;
  colorRing?: string;
  colorInputBackground?: string;
  colorInputText?: string;
  colorMuted?: string;
  colorShadow?: string;
  borderRadius?: string;
  fontFamily?: string;
  fontFamilyButtons?: string;
  fontSize?: string;
  fontWeight?: string | number;
  fontWeightBold?: string | number;
  spacingUnit?: string;
  /** Any additional token is exposed as `--orbitid-<kebab-case-key>`. */
  [key: string]: string | number | undefined;
}

/**
 * Layout switches shared by every OrbitID component. Components read these through
 * `useAppearance().layout` so a single prop drives the whole tree.
 */
export interface AppearanceLayout {
  socialButtonsVariant?: "blockButton" | "iconButton" | "auto";
  socialButtonsPlacement?: "top" | "bottom";
  logoPlacement?: "inside" | "outside" | "none";
  logoImageUrl?: string;
  logoLinkUrl?: string;
  applicationName?: string;
  showOptionalFields?: boolean;
  termsPageUrl?: string;
  privacyPageUrl?: string;
  helpPageUrl?: string;
  unsafe_disableDevelopmentModeWarnings?: boolean;
  shimmer?: boolean;
  [key: string]: unknown;
}

/** Non-class overrides for a single element. */
export interface AppearanceElementStyle {
  className?: string;
}

/**
 * Per-element override, keyed by Clerk's element names (`card`, `headerTitle`,
 * `formButtonPrimary`, `formFieldInput`, `footerActionLink`, `socialButtonsBlockButton`, ...).
 */
export type AppearanceElement =
  | string
  | AppearanceElementStyle
  | ((...args: unknown[]) => string | AppearanceElementStyle | undefined);

export type AppearanceElements = Record<string, AppearanceElement> & {
  rootBox?: AppearanceElement;
  card?: AppearanceElement;
  cardBox?: AppearanceElement;
  header?: AppearanceElement;
  headerTitle?: AppearanceElement;
  headerSubtitle?: AppearanceElement;
  main?: AppearanceElement;
  footer?: AppearanceElement;
  footerAction?: AppearanceElement;
  footerActionText?: AppearanceElement;
  footerActionLink?: AppearanceElement;
  footerPages?: AppearanceElement;
  footerPageLink?: AppearanceElement;
  dividerLine?: AppearanceElement;
  dividerText?: AppearanceElement;
  form?: AppearanceElement;
  formField?: AppearanceElement;
  formFieldLabel?: AppearanceElement;
  formFieldInput?: AppearanceElement;
  formFieldInputShowPasswordButton?: AppearanceElement;
  formFieldErrorText?: AppearanceElement;
  formFieldHintText?: AppearanceElement;
  formFieldSuccessText?: AppearanceElement;
  formButtonPrimary?: AppearanceElement;
  formButtonReset?: AppearanceElement;
  formButtonPrimaryText?: AppearanceElement;
  socialButtons?: AppearanceElement;
  socialButtonsBlockButton?: AppearanceElement;
  socialButtonsBlockButtonText?: AppearanceElement;
  socialButtonsIconButton?: AppearanceElement;
  socialButtonsProviderIcon?: AppearanceElement;
  alert?: AppearanceElement;
  alertText?: AppearanceElement;
  badge?: AppearanceElement;
  avatarBox?: AppearanceElement;
  avatarImage?: AppearanceElement;
  profileSection?: AppearanceElement;
  profileSectionTitle?: AppearanceElement;
  profileSectionTitleText?: AppearanceElement;
  profileSectionContent?: AppearanceElement;
  profileSectionPrimaryButton?: AppearanceElement;
  profilePage?: AppearanceElement;
  navbar?: AppearanceElement;
  navbarButton?: AppearanceElement;
  pageScrollBox?: AppearanceElement;
  page?: AppearanceElement;
  modalContent?: AppearanceElement;
  modalBackdrop?: AppearanceElement;
  modalCloseButton?: AppearanceElement;
  otpCodeFieldInput?: AppearanceElement;
  identityPreview?: AppearanceElement;
  identityPreviewText?: AppearanceElement;
  identityPreviewEditButton?: AppearanceElement;
  table?: AppearanceElement;
  tableHead?: AppearanceElement;
  tableBody?: AppearanceElement;
  tableRow?: AppearanceElement;
  tableCell?: AppearanceElement;
  paginationButton?: AppearanceElement;
  paginationButtonNext?: AppearanceElement;
  paginationButtonPrevious?: AppearanceElement;
  paginationRowText?: AppearanceElement;
  loader?: AppearanceElement;
  spinner?: AppearanceElement;
  loadingScreen?: AppearanceElement;
};

/**
 * A named bundle of tokens that components merge underneath the `appearance` prop.
 * `baseTheme` accepts one theme or an array (applied in order, later wins).
 */
export interface BaseTheme {
  name: string;
  /** Extra class names for the `orbitid-root` wrapper (e.g. `['dark']`). */
  classNames?: string[];
  variables?: AppearanceVariables;
  layout?: AppearanceLayout;
  elements?: AppearanceElements;
}

export interface Appearance {
  /** One theme, or several merged in order. Defaults to `defaultTheme`. */
  baseTheme?: BaseTheme | BaseTheme[];
  variables?: AppearanceVariables;
  layout?: AppearanceLayout;
  elements?: AppearanceElements;
}

/** Fully merged appearance, produced once by the provider and shared through context. */
export interface ResolvedAppearance {
  appearance: Appearance;
  /** Last theme in the `baseTheme` list, or `defaultTheme`. */
  theme: BaseTheme;
  themes: BaseTheme[];
  variables: AppearanceVariables;
  layout: AppearanceLayout;
  elements: AppearanceElements;
  /** CSS custom properties, ready for a `style` attribute. */
  cssVariables: Record<string, string>;
  /** Wrapper classes: `orbitid-root`, theme class names (e.g. `dark`), `rootBox` override. */
  rootClassName: string;
}
