# Customizing the prebuilt components

The sign-in, sign-up, waitlist, user button, user profile, organization and API key components take one
`appearance` object. It has five layers, each optional, and they combine in a fixed order:

| Layer | What it is for |
| --- | --- |
| `baseTheme` | A named preset (`light`, `dark`, `soft`, `contrast`, `flat`) or your own. |
| `variables` | Design tokens: colors, radius, font, text size, spacing, shadow strength. |
| `elements` | Classes and inline styles for one named part of a component (`formButtonPrimary`, `cardBox`, …). |
| `layout` | Behavior switches: logo, social buttons, footer links, motion. |
| `unstyled` | Drop OrbitID's own classes and style everything yourself. |

Pass it to `<OrbitIDProvider>` for the whole app, or to one component. A component's `appearance` is a layer on
top of the provider's.

```tsx
import { OrbitIDProvider, SignIn, dark, soft } from "@orbitid/react";
import "@orbitid/ui/styles.css";

<OrbitIDProvider
  publishableKey={key}
  appearance={{
    baseTheme: soft,
    variables: { colorPrimary: "#2563eb", borderRadius: "10px", fontFamily: "Inter, sans-serif" },
    elements: { formButtonPrimary: "uppercase tracking-wide" },
    layout: { socialButtonsVariant: "iconButton", helpPageUrl: "https://example.com/help" },
  }}
>
  <SignIn appearance={{ baseTheme: dark, elements: { cardBox: "shadow-none" } }} />
</OrbitIDProvider>
```

## Precedence

Lowest first. A later step wins any conflict, and nothing earlier is thrown away unless it conflicts.

1. `@orbitid/ui/styles.css`: the default tokens and each component's own classes.
2. Instance branding from the dashboard (**Settings → Appearance**): the primary color and the default theme.
3. The base themes of the **last** layer that sets `baseTheme`. A component's `baseTheme` replaces the
   provider's rather than stacking on it, so the scheme and the theme's colors always come from the same themes.
   A component without `baseTheme` keeps the provider's. `baseTheme: []` resets to the default theme.
4. The provider's own `variables`, `layout` and `elements`.
5. Each component's own `variables`, `layout` and `elements`.

Rules inside that order:

- **Variables and layout** replace earlier values key by key. `colorText`, `colorTextSecondary` and
  `colorInputText` are older names. Each layer's older names are rewritten to the current names
  (`colorForeground`, `colorMutedForeground`, `colorInputForeground`) before layers merge, so an older name in a
  later layer still wins; inside one layer the current name wins when both are set.
- **Elements accumulate.** Every layer's classes are kept, earliest first, and `style` objects merge in the same
  order. tailwind-merge keeps the last conflicting utility, so `p-6` from the component beats `p-2` from the
  provider while the provider's `shadow-none` stays.
- **On one DOM node, generic keys come before specific ones.** A sign-in submit button carries `button`, then
  `buttonPrimary`, then `formButtonPrimary`. Style all primary buttons with `buttonPrimary` and still give the
  sign-in submit its own look with `formButtonPrimary`.
- **The scheme** (light or dark) comes from the active base themes (those of the last layer that sets
  `baseTheme`): the last `light`/`dark` theme among them wins, and in `[dark, light]` the earlier `dark` theme's
  variables are dropped too, so scheme and tokens agree. That drops all of that theme's variables, typography,
  radius and spacing included; put scheme-independent values in a theme without `dark`/`light`, or in `variables`. Without one, the instance's branding theme decides, then the
  page (`<html class="dark">`, `data-theme`, `color-scheme`), then the OS.
- `unstyled` takes the last value set across layers. An element's own `unstyled` (true or false) beats it.
- **Bad input does not crash.** `null` or `undefined` layers, themes and parts are skipped. A string `baseTheme`
  (`"dark"` instead of the `dark` object) is ignored with a development warning.

Tip: pass a stable `appearance` object (a module constant or `useMemo`). A new object on every render re-resolves
the appearance each time.

The same input always produces the same output; the tests in `packages/react/src/__tests__/appearance-layers.test.tsx`
pin each rule.

## Base themes

```tsx
import { light, dark, soft, contrast, flat } from "@orbitid/react";

appearance={{ baseTheme: [dark, soft] }} // several merge in order
```

| Theme | What it does |
| --- | --- |
| `light` / `dark` | Forces the scheme. Without either, components follow the page. |
| `soft` | Rounder corners (0.875rem), lighter borders, gentler shadows, block social buttons. |
| `contrast` | Strong borders and focus ring, square-ish corners, no shadows, darker secondary text. |
| `flat` | No elevation at all: hairlines only. Good inside a page that already draws a card. |

`dark` also writes its tokens inline on the component root (card, text, primary, borders…). It therefore overrides
an app's own `.dark { --card: … }` customizations, and its primary color sits above the instance's brand color in
the precedence; only your own `variables` override it. To keep your own dark tokens, leave `baseTheme` unset and
mark the page dark instead, or set the colors you want in `variables`.

All three non-scheme presets work in light and dark. A theme of your own is a plain object:

```ts
import type { BaseTheme } from "@orbitid/react";

export const acme: BaseTheme = {
  name: "acme",
  classNames: ["acme-auth"], // added to the component root, for your own CSS
  variables: { colorPrimary: "#0f766e", fontFamily: "'IBM Plex Sans', sans-serif" },
  elements: { headerTitle: "font-semibold" },
  layout: { socialButtonsPlacement: "bottom" },
};
```

## Variables

Each variable sets custom properties on each component's root element, never on the provider's wrapper around your
app, so even provider-level variables such as `spacingUnit` or `fontSize` never rescale your own page. Menus and
dialogs a component opens get the same values through a scoped class. Colors take any CSS color. The on-color for
`colorPrimary` and `colorDanger` is computed for hex, `rgb()`, `hsl()` and `oklch()` values; for anything else
(named colors, `var()`, `color-mix()`) the theme's default stays and a development warning says so (set
`colorPrimaryForeground` to choose it yourself).

`fontSize` only scales text when given in `px` or `rem`; other units are ignored with a development warning. Every
text size inside the prebuilt components multiplies the resulting `--font-scale`.

```tsx
appearance={{
  variables: {
    colorPrimary: "#7c3aed",
    colorBackground: "#ffffff",
    colorForeground: "#18181b",
    colorMuted: "#f4f4f5",
    colorDanger: "#dc2626",
    colorInput: "#a1a1aa",
    borderRadius: "0.625rem",
    fontFamily: "Inter, sans-serif",
    fontSize: "15px",
    spacingUnit: "0.27rem",
    shadowStrength: 0.6,
  },
}}
```

| Variable | Sets | What it changes |
| --- | --- | --- |
| `colorPrimary` | `--primary`, `--orbitid-color-primary`, `--primary-foreground` (computed) | Primary buttons, links, selected states. The text on it is picked for contrast unless `colorPrimaryForeground` is set. |
| `colorPrimaryForeground` | `--primary-foreground` | Text and icons on `colorPrimary`. |
| `colorBackground` | `--card`, `--popover`, `--orbitid-color-background` | The component's card and pop-over surface. |
| `colorForeground` | `--foreground`, `--card-foreground`, `--popover-foreground`, `--orbitid-color-text` | Main text. |
| `colorMuted` | `--muted`, `--secondary`, `--orbitid-color-muted` | Quiet surfaces: the footer band, chips, hover rows. |
| `colorMutedForeground` | `--muted-foreground`, `--orbitid-color-text-secondary` | Secondary text: subtitles, hints, column headers. |
| `colorNeutral` | `--accent`, `--orbitid-color-neutral` | Hover and selected backgrounds of menus and ghost buttons. |
| `colorDanger` | `--destructive`, `--orbitid-color-danger`, `--destructive-foreground` (computed) | Destructive buttons and errors. Its on-color is computed. |
| `colorSuccess` | `--go`, `--orbitid-color-success` | Success status. |
| `colorWarning` | `--caution`, `--orbitid-color-warning` | Warnings, including the development-mode banner. |
| `colorInfo` | `--info`, `--orbitid-color-info` | Informational status. |
| `colorBorder` | `--border`, `--orbitid-color-border` | Hairline borders of cards, tables and dividers. |
| `colorInput` | `--input`, `--orbitid-color-input` | Input, select and checkbox borders. |
| `colorInputBackground` | `--input-background`, `--orbitid-color-input-background` | Input background (transparent by default). |
| `colorInputForeground` | `--input-foreground`, `--orbitid-color-input-text` | Typed text in inputs. |
| `colorRing` | `--ring`, `--orbitid-color-ring` | Keyboard focus outline. |
| `colorShadow` | `--shadow-color`, `--orbitid-color-shadow` | Ink of every shadow. |
| `shadowStrength` | `--shadow-strength` | Multiplies every shadow's opacity: `0` none, `1` default, `2` double. |
| `borderRadius` | `--radius`, `--orbitid-border-radius` | Base radius of controls. Cards use 1.5×, chips 0.75×, the auth card 1.5×. `0` is square. |
| `fontFamily` | `--font-sans`, `--orbitid-font-family` | Font of the component. |
| `fontFamilyButtons` | `--orbitid-font-family-buttons` | Font of buttons only. |
| `fontSize` | `--orbitid-font-size`, `--font-scale` (computed) | Base text size (`14px` default). In `px` or `rem` it also sets `--font-scale`, which every text size inside multiplies. |
| `fontWeight` | `--orbitid-font-weight` | Exposed for your own CSS. |
| `fontWeightBold` | `--orbitid-font-weight-bold` | Exposed for your own CSS. |
| `spacingUnit` | `--spacing`, `--orbitid-spacing-unit` | The step every padding, gap and margin multiplies (Tailwind's `--spacing`, `0.25rem` default). |

Older names still work: `colorText` (now `colorForeground`), `colorTextSecondary` (`colorMutedForeground`) and
`colorInputText` (`colorInputForeground`). Any other key becomes `--orbitid-<kebab-case-key>` for your own CSS:
`brandAccent` → `--orbitid-brand-accent`.

## Elements

Every key accepts a class string, an object, a function (called with no arguments) returning either, or a list of
those:

```tsx
appearance={{
  elements: {
    cardBox: "shadow-none border-2",
    headerTitle: { className: "text-2xl", style: { letterSpacing: "-0.02em" } },
    formButtonPrimary: ["rounded-full", { style: { textTransform: "uppercase" } }],
    socialButtonsIconButton: () => (isMobile ? "h-11" : "h-9"),
    dividerRow: { unstyled: true, className: "my-6 flex items-center gap-2" },
  },
}}
```

- `className` is merged after OrbitID's classes with tailwind-merge, so your conflicting utilities win.
- `style` is applied inline after OrbitID's style.
- `unstyled: true` drops OrbitID's classes from that element only; `unstyled: false` restores them on that element
  when `appearance.unstyled` is on. When several keys land on one element, the most specific key's setting wins.
- A function that throws is ignored (with a development warning), so one bad override cannot break the form.
- Every element also gets a stable class per key, `orbitid-<key>` (for example `orbitid-button
  orbitid-buttonPrimary orbitid-formButtonPrimary` on the sign-in submit), so plain CSS can target it. Parts named
  with a component key also carry `data-orbitid-element="<key>"`, except `formFieldInputGroup`: the one-time code
  library renders that row itself, so target it with `.orbitid-formFieldInputGroup`.

There are two kinds of keys.

**Primitive keys** are declared by the `@orbitid/ui` building blocks themselves, so they cover every component,
including ones added later, with no extra code. `buttonPrimary` restyles every primary button in every component.

| Key | Applies to |
| --- | --- |
| `button` | Every button. |
| `buttonPrimary` | Filled primary buttons. |
| `buttonSecondary` | Filled secondary buttons. |
| `buttonOutline` | Outlined buttons, including social buttons. |
| `buttonGhost` | Borderless buttons (menus, icon actions). |
| `buttonDanger` | Destructive buttons. |
| `buttonLink` | Buttons styled as links. |
| `input` | Text inputs, textareas and select triggers. |
| `textarea` | Multi-line inputs. |
| `selectTrigger` | The closed state of a select. |
| `selectContent` | The open list of a select. |
| `selectItem` | One option in a select. |
| `checkbox` | Checkboxes. |
| `switch` | Toggle switches. |
| `label` | Field labels. |
| `card` | Every card surface. |
| `cardHeader` | Card header area. |
| `cardTitle` | Card titles. |
| `cardDescription` | Card descriptions. |
| `cardContent` | Card body. |
| `cardFooter` | Card footer area. |
| `badge` | Every badge or chip. |
| `badgePrimary` | Filled badges. |
| `badgeSecondary` | Quiet badges. |
| `badgeOutline` | Outlined badges. |
| `badgeGhost` | Borderless badges. |
| `badgeDanger` | Destructive badges. |
| `badgeLink` | Badges styled as links. |
| `avatarBox` | Avatar container. |
| `avatarImage` | Avatar image. |
| `avatarFallback` | Initials shown when there is no image. |
| `alert` | Inline alerts and form errors. |
| `alertTitle` | Alert title. |
| `alertText` | Alert body text. |
| `separator` | Horizontal and vertical rules. |
| `table` | Tables. |
| `tableHeader` | Table header group. |
| `tableBody` | Table body group. |
| `tableRow` | Table rows. |
| `tableHead` | Column headers. |
| `tableCell` | Table cells. |
| `modalBackdrop` | The scrim behind dialogs. |
| `modalContent` | Dialog surface. |
| `modalHeader` | Dialog header. |
| `modalFooter` | Dialog action row. |
| `modalTitle` | Dialog title. |
| `modalDescription` | Dialog description. |
| `menuList` | Dropdown menu surface. |
| `menuItem` | Dropdown menu item. |
| `menuLabel` | Dropdown menu group label. |
| `menuSeparator` | Dropdown menu divider. |
| `popoverContent` | Pop-over surface. |
| `tooltip` | Tooltips. |
| `tabsList` | Tab bar. |
| `tabsTrigger` | One tab. |
| `skeleton` | Loading placeholders. |

**Component keys** name a part of a particular flow. A component key on a primitive applies after the primitive
keys.

| Key | Applies to |
| --- | --- |
| `rootBox` | Outermost element of each component. |
| `cardBox` | The main card of sign-in, sign-up, waitlist, consent and profile. |
| `header` | Card header: logo, title and subtitle. |
| `headerTitle` | Card or page title. |
| `headerSubtitle` | Card subtitle. |
| `logoBox` | Logo container. |
| `logoImage` | Logo image (or the OrbitID mark). |
| `main` | Card body below the header. |
| `form` | A form inside a card. |
| `developmentModeBanner` | Banner shown while the instance is in development mode. |
| `footer` | Card footer band. |
| `footerAction` | "Don't have an account? Sign up" row. |
| `footerActionText` | Text of the footer action. |
| `footerActionLink` | Link of the footer action. |
| `footerPages` | Terms, privacy and help links. |
| `footerPagesLink` | One terms, privacy or help link. |
| `socialButtons` | Group of social sign-in buttons. |
| `socialButtonsBlockButton` | Full-width social button. |
| `socialButtonsBlockButtonText` | Label inside a full-width social button. |
| `socialButtonsIconButton` | Icon-only social button. |
| `socialButtonsProviderIcon` | Provider logo inside a social button. |
| `lastUsedBadge` | "Last used" marker on a social button. |
| `dividerRow` | The "or" divider row. |
| `dividerLine` | Lines on each side of the divider. |
| `dividerText` | The divider's text. |
| `formField` | One label + input + message group. |
| `formFieldLabel` | Field label. |
| `formFieldInput` | Field input (text, password, phone, select). |
| `formFieldInputGroup` | The row that holds the one-time code slot groups. Takes classes and `unstyled`; a `style` override does not reach it, and it has no `data-orbitid-element` attribute (use `.orbitid-formFieldInputGroup`). |
| `formFieldInputShowPasswordButton` | Show/hide password toggle. |
| `formFieldHintText` | Helper text under a field. |
| `formFieldErrorText` | Validation message under a field. |
| `formButtonPrimary` | Main submit button of a step. |
| `formButtonSecondary` | Secondary action of a step (back, use another method). |
| `formResendCodeLink` | Resend code button. |
| `otpCodeField` | One-time code field. |
| `otpCodeFieldInput` | One slot of a one-time code field. |
| `identityPreview` | Chip showing the identifier being signed in. |
| `identityPreviewText` | Identifier text in the chip. |
| `identityPreviewEditButton` | Edit button in the chip. |
| `captcha` | Captcha container. |
| `loader` | Loading indicator of `<OrbitIDLoading>`. |
| `userButtonBox` | User button wrapper. |
| `userButtonTrigger` | User button trigger. |
| `userButtonAvatarBox` | Avatar inside the trigger. |
| `userButtonOuterIdentifier` | Name next to the avatar. |
| `userButtonPopover` | The user button's menu. |
| `userButtonPopoverActionButton` | One action in the user button's menu. |
| `userProfile` | User profile root. |
| `userProfileNavbar` | User profile navigation. |
| `userProfilePage` | User profile page area. |
| `navbar` | Side navigation of profile components. |
| `navbarButton` | One navigation entry. |
| `navbarButtonIcon` | Icon of a navigation entry. |
| `pageScrollBox` | Scrolling page area of profile components. |
| `profileSection` | A section of a profile page. |
| `profileSectionTitle` | Section title. |
| `profileSectionPrimaryButton` | Main action of a section. |
| `organizationSwitcherTrigger` | Organization switcher trigger. |
| `organizationSwitcherPopover` | Organization switcher menu. |
| `organizationPreview` | Organization or personal-account avatar. |
| `organizationList` | Organization list root. |
| `organizationProfile` | Organization profile root. |
| `createOrganization` | Create organization root. |
| `apiKeys` | API keys root. |

## Layout

| Option | Default | Effect |
| --- | --- | --- |
| `logoPlacement` | `"inside"` | `"inside"` the card header, `"outside"` above the card, or `"none"`. |
| `logoImageUrl` | instance logo | Logo image. Without one, the OrbitID mark in the primary color. |
| `logoLinkUrl` | instance home URL | Where the logo links. |
| `socialButtonsVariant` | `"auto"` | `"blockButton"` (one full-width button each), `"iconButton"` (a row of icons), or `"auto"` (icons above three providers). |
| `socialButtonsPlacement` | `"top"` | Social buttons above or `"bottom"` below the form. |
| `showOptionalFields` | `true` | `false` hides optional name fields on sign-up, and an optional username when email or phone is collected. |
| `showFooterPages` | `true` | `false` hides the help, privacy and terms links. |
| `helpPageUrl` | none | Adds a Help link to the card footer. |
| `privacyPageUrl` / `termsPageUrl` | instance URLs | Override the instance's privacy and terms links. |
| `showDevelopmentModeWarning` | `true` | `false` hides the development-mode banner. |
| `unsafe_disableDevelopmentModeWarnings` | `false` | Older name: `true` is the same as `showDevelopmentModeWarning: false`. |
| `animations` | `true` | `false` turns off transitions and entrance animations inside the components (spinners keep turning). |

## Restyling everything with Tailwind, shadcn or plain CSS

**Tailwind classes in `elements`.** The components are built from the same shadcn primitives your app may use,
styled with Tailwind v4 utilities and the shadcn variables. Classes you pass are merged with tailwind-merge, so
`elements: { cardBox: "rounded-none" }` replaces the card's radius rather than fighting it.

**Plain CSS on the stable classes.** `@orbitid/ui/styles.css` puts every utility in Tailwind's `@layer utilities`
(and the base rules in `@layer base`). CSS outside a layer always beats layered CSS, whatever the specificity, so
an ordinary rule wins without `!important`:

```css
.orbitid-cardBox { border-radius: 0; box-shadow: none; }
.orbitid-formButtonPrimary { background: #111; letter-spacing: 0.02em; }
.orbitid-theme-acme .orbitid-headerTitle { font-family: "Fraunces", serif; }
```

If your own CSS lives in a layer, declare your layer after Tailwind's: `@layer theme, base, components, utilities, app;`.

**Your tokens.** The components read the shadcn variables (`--primary`, `--card`, `--border`, `--radius`, …).
Define them in your stylesheet (on `:root`, `.dark`, or any wrapper) and the components follow; `variables`
are only a shortcut that scopes them to the component.

**`unstyled`.** `appearance={{ unstyled: true }}` removes OrbitID's classes from every element that has a key:
the primitive's own recipe and the component's layout classes on it. What stays:

- your `elements` classes and `style`, and the `orbitid-<key>` hooks;
- on each component root, the scheme class (`dark`/`light`), `orbitid-root`, `orbitid-component` and your theme's
  `classNames`;
- the CSS variables (branding and `variables`), the markup and accessibility attributes;
- classes on small inner parts without a key (icons, a few wrappers).

Use it when you want to own the whole look; you then style each element through `elements` or the stable
classes. Element-level `unstyled: true` does the same for one part, and `unstyled: false` exempts one part.

## Building your own components on the same system

Custom pages inside `<UserProfile>` and `<OrganizationProfile>`, and any component you build from `@orbitid/ui`
primitives inside a prebuilt component, pick up the primitive keys automatically. To give your own part a key:

```tsx
import { useElementProps } from "@orbitid/react";

function PlanBadge() {
  const ep = useElementProps();
  return <span {...ep("badge", "text-xs")}>Owner</span>;
}
```

`ep(key, ...classes)` returns `{ className, style, "data-orbitid-element" }` with the appearance applied.

## Limitations

- Theme `classNames` (for example `orbitid-theme-soft`) land on each component root but not on the menus and
  dialogs a component opens, which render under `<body>`. Those pop-ups do get the scheme, the variables and their
  element keys; target them through the element keys (`modalContent`, `menuList`, …) rather than a theme class.

## Changes from the first appearance release

- The provider's wrapper around your app no longer carries the variables, theme class names or `rootBox`; each
  component root does. `rootBox` now styles each component's root.
- A component's `baseTheme` replaces the provider's instead of stacking on it.
- `variables.colorBackground` sets the component's card and pop-over surface (`--card`, `--popover`), not the page
  `--background`.
- `elements.form` now styles the `<form>` element itself; the card body is `main`.
- Renamed or removed keys: `footerPageLink` is `footerPagesLink`; `formButtonReset` and the `paginationButton*`
  keys were never attached to anything and are gone; `badge`, `menuItem`, `table*` and `avatar*` now apply to every
  primitive of that kind.
- `layout.applicationName` and `layout.shimmer` were never read and are gone.

## Instance branding

**Settings → Appearance** in the dashboard stores the instance's primary color and default theme, and every prebuilt component reads them (step 2 of the precedence). Any `variables.colorPrimary`
replaces the branded color. A dark brand color is not used on a dark surface, where it would vanish; the theme's
primary takes over. The same page has a variables playground with a live preview that writes an `appearance`
snippet to copy into your app.
