---
name: OrbitID
description: Self-hosted authentication on your own Postgres, drawn as calm, precise working software.
colors:
  background: "oklch(0.985 0.002 85)"
  card: "oklch(1 0 0)"
  ink: "oklch(0.21 0.006 60)"
  ink-muted: "oklch(0.5 0.008 70)"
  border: "oklch(0.91 0.003 85)"
  input: "oklch(0.63 0.004 85)"
  ring: "oklch(0.52 0.01 60)"
  sidebar: "oklch(0.975 0.002 85)"
  rail: "oklch(0.21 0.006 60)"
  signal: "oklch(0.57 0.235 28)"
  go: "oklch(0.5 0.12 150)"
  caution: "oklch(0.52 0.11 75)"
  info: "oklch(0.52 0.13 250)"
  background-dark: "oklch(0.165 0.004 60)"
  card-dark: "oklch(0.2 0.004 60)"
  ink-dark: "oklch(0.95 0.003 85)"
  border-dark: "oklch(0.285 0.004 60)"
  signal-dark: "oklch(0.68 0.2 27)"
typography:
  caption:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.6875rem"
    fontWeight: 500
    lineHeight: 1.4
  label:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.75rem"
    fontWeight: 500
    lineHeight: 1.4
  body:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  card-title:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 620
    lineHeight: 1.375
    letterSpacing: "-0.01em"
  heading:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 620
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  figure:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 620
    lineHeight: 1.1
  data:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 450
    lineHeight: 1.4
rounded:
  base: "var(--radius) = 0.5rem"
  sm: "0.75 × base (6px)"
  md: "base (8px)"
  lg: "1.25 × base (10px)"
  xl: "1.5 × base (12px)"
  pill: "999px"
spacing:
  unit: "0.25rem (Tailwind --spacing)"
  tight: "4–8px"
  siblings: "16–20px"
  sections: "32px"
elevation:
  xs: "contact shadow under controls and resting cards"
  card: "contact + soft ambient, the auth card and profile card"
  overlay: "deeper two-step shadow for dialogs, menus, pop-overs"
  strength: "--shadow-strength multiplies every shadow (0 removes them)"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.background}"
    rounded: "{rounded.md}"
    height: "34px (36px in the auth card)"
    padding: "0 14px"
  button-outline:
    backgroundColor: "{colors.card}"
    border: "1px {colors.border}"
    shadow: "{elevation.xs}"
  auth-card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.xl}"
    width: "25rem"
    padding: "32px"
    shadow: "{elevation.card}"
  line-code:
    backgroundColor: "{colors.rail}"
    textColor: "oklch(0.95 0.003 85)"
    rounded: "{rounded.sm}"
    size: "22px"
---

# Design system

## Overview

OrbitID is operated by developers and by support staff, and its prebuilt components sit inside other people's
products. Both want the same thing from the interface: calm, precise software that gets out of the way. The look
is a quiet neutral ground, white cards drawn with a crisp 1px border and a soft layered shadow, ink type in one
grotesque, and a single signal red kept for danger and for the active item. Personality lives in the details:
the mascot, the tabular figures, the departures-board activity feed, the exact rhythm of a sign-in card.

Product truth the design keeps visible: the instance lives in the operator's own database, at the operator's own
URL. Both appear in the sidebar header and the top bar on every dashboard screen.

Surface mode: Operate (dashboard, test website) and Operate-embedded (the prebuilt SDK components, which must look
at home in any host app and be restyled to its brand). Light and dark are both first class. Dark is chosen by the
operator or the host page, never forced.

## Colors

Restrained, near-neutral palette. Hues carry a hint of warmth (85) so the greys never read as blue.

- The ground is a near-white (`background`). Cards and pop-overs are pure white (`card`), one clear step above it.
  In dark mode the ground is a deep warm grey and cards sit one step lighter, pop-overs one more.
- Ink is a warm near-black and doubles as the default primary: primary buttons are ink, inverted in dark.
  Instance branding (a primary color set in the dashboard) replaces it in the prebuilt components, except a dark
  brand color on a dark surface, which would vanish.
- Muted ink is for secondary text only and meets 4.5:1 on every ordinary surface.
- Borders are hairlines (`border`). Input, select and checkbox borders are darker (`input`, 3:1 on every surface)
  because they are the only thing that marks a field.
- Signal red marks danger and the active navigation item's icon. Go green, caution amber and info blue exist only
  as status, and status is never color alone: a word or a shape always comes with it.
- Charcoal (`rail`) survives in one place: the line codes of the activity board and code snippets.
- Chart series use ink and signal red first, then muted ink. No rainbow palettes.

## Typography

One family carries the interface: Hanken Grotesk (variable, self-hosted). JetBrains Mono carries ids, keys,
timestamps, claims and code, and nothing else. Numbers in tables and counters use tabular figures.

Fixed rem scale: 0.6875 (captions), 0.75 (labels, column headers), 0.8125 (data), 0.875 (body), 1, 1.125 (card
titles), 1.375 (page titles), 1.75 (figures). Headings are weight 620 with −0.01 to −0.015em tracking. Column
headers are sentence case, 0.75rem, weight 500, muted; they sit in the row they head and there are no eyebrow
labels above headings. Every text size multiplies `--font-scale` (1 by default), which is how `appearance.variables
.fontSize` scales a component without touching the host page.

## Layout

- Shell: a 232px sidebar on a neutral surface one step off the ground (grouped navigation, instance name and API
  host at the top), a 48px top bar (breadcrumb, instance chip, command search, theme and account menu), content on
  the ground, fluid to 1280px with 24px gutters.
- The active navigation item is a white, hairline-ringed chip with a contact shadow and a signal-red icon; hover is
  a quiet tint.
- Spacing runs on a 4px unit (`--spacing`). Tight groups use 4–8px, siblings 16–20px, sections 32px, with more
  space above a heading than below it.
- The sidebar collapses to icons below 1024px and to a sheet below 768px. Tables become stacked rows below 640px.
- Tables are the primary object: 40px rows, hairline rules, no zebra, a quiet hover tint, no card around a table
  that already has a border.
- Page structure: title row (title, one-line description, primary action), then filters, then the data. Detail
  pages put identity (avatar, name, identifier, status chips) in a header band, then tabs.
- The auth components are card-centered: one 25rem card, 32px padding, logo, title and subtitle centered at the
  top, the step in the middle, and a quiet footer band (muted tint, top hairline) for "Secured by" and the help,
  privacy and terms links. The user profile is one wide card with a muted navigation column and the page beside it.

## Elevation & Depth

Every surface is a 1px border plus a shadow token, and every shadow token is scaled by `--shadow-strength`:

- `shadow-xs`: a 1px contact shadow under buttons, inputs and resting cards. It gives controls a crisp edge without
  looking raised.
- `shadow-card`: the contact shadow plus a soft ambient one with a real offset (8px, 24px blur, pulled in). Only
  the auth card and the profile card get it.
- `shadow-overlay`: two-step and deeper, for dialogs, menus, selects and pop-overs, which also sit on `popover`.

In dark mode the shadow ink is near-black and the strength rises (2.6×) so surfaces still separate. The scrim is
warm ink, not pure black. No glows, no gradients, no blur as decoration. Centered overlays are capped to the
visible viewport, including safe-area insets, and scroll inside.

## Shapes

Softly rounded, from one base radius (`--radius`, 8px): chips and menu items 6px, controls 8px, cards, dialogs and
the auth card 12px. Pills only for the avatar trigger, identity chip and the smallest status chips. Setting
`--radius` (or `appearance.variables.borderRadius`) re-scales every shape at once; 0 makes everything square. No
colored side-borders on cards or alerts.

## Components

Stock shadcn/ui primitives from `packages/ui`, restyled through tokens only. Every interactive component has
default, hover, focus-visible, active, disabled, loading and error states.

- Focus: a 2px outline in `ring` (a mid ink, 3:1 on every surface), offset 2px, declared once outside the utility
  layer so nothing can erase it.
- Buttons: primary is ink with a contact shadow; outline is white with a hairline and contact shadow; destructive
  is signal red. One primary action per view.
- Inputs: 34px, `input` border, contact shadow, error text that states the problem and the fix.
- Social buttons: outline buttons, 36px, provider mark plus "Continue with …"; four or more collapse into an even
  grid of icon buttons with tooltips. A "Last used" chip marks the previous method.
- Divider: hairlines either side of a lowercase muted "or".
- Status chip: a word plus a 6px dot (`Active`, `Banned`, `MFA`, `Failed`). Never a dot alone.
- Empty states say what the screen will contain and give the next action, in a sentence.
- Skeletons for loading, never a centered spinner over content.
- Icons: lucide, 1.5px stroke, 16px, one style everywhere.
- Motion: transitions on color, border and shadow only, 150ms. Overlays enter in 200ms on `ease-out-expo` (fade,
  97% scale, 8px lift) and leave in 150ms on `ease-in-quick`; sheets slide in 300ms. Nothing loops, and
  `prefers-reduced-motion` (or `appearance.layout.animations: false`) turns it all into an instant swap.
- The mark: a blob with two eyes, wrapped by a ring, on a rounded tile. Light mode uses the ink blob on a paper tile
  (`assets/icon.svg`), dark mode the paper blob on an ink tile (`assets/icon-dark.svg`). `AppIcon` draws the tile
  and follows the theme; `OrbitMark` draws the bare mascot in `currentColor` (the prebuilt card shows it in the
  primary color when the instance has no logo). The mark never carries signal red.

### Customization contract

The prebuilt components are themed through one layered `appearance` object (see `docs/APPEARANCE.md`):
`baseTheme` presets, `variables` mapped onto the custom properties above, `elements` keyed by stable names, and
`layout` switches. Rules the design keeps:

- Every visual decision in a component is a token or a class on a named element. Nothing is hardcoded per page.
- Primitives declare their own element keys (`button`, `buttonPrimary`, `input`, `card`, `table`, `modalContent`…),
  so a new component built from them is themeable with no extra work.
- Variables are set on the component root only. A component never restyles the host page.
- All styling lives in Tailwind's layers, so a host's plain, unlayered CSS on the `orbitid-<key>` classes wins.

### Signature move: the activity board

Recent sign-ins, sessions and webhook deliveries are set like a departures board. Strict columns: time (mono,
tabular, `14:02`), line code, who (name over identifier), where (device and place), outcome (word plus dot). The
line code is a 22px charcoal square carrying one letter for the method: P password, E email code, M email link, S
SMS, K passkey, O OAuth, T authenticator, B backup code, X SSO. A failed attempt turns the line code signal red.
New rows appear at the top with a 160ms ease-out slide and a one-time red hairline that fades. The board appears on
Overview (live), on a user's Activity tab and in the test website's Inspector. It is built from a normal table,
with real column headers, so it stays accessible.

## Do's and Don'ts

Do
- Show real instance data: counts, methods, keys, the database in use and the URL.
- Keep red scarce. If more than one thing per screen is red, something is wrong.
- Use sentence case everywhere. Name the action on every button.
- Mark dangerous actions (delete, rotate key) with a plain sentence of what happens.
- Give every new part of a prebuilt component an element key and build it from the primitives.

Don't
- Mention other vendors' products in the interface or in copy, or borrow another product's branding.
- Add an eyebrow label above a heading, gradient text, glass, glows, or hard offset shadows.
- Use a shadow without its hairline border, or a stock Tailwind shadow instead of the elevation tokens.
- Use emoji or Unicode glyphs as icons, or monospace as decoration.
- Wrap tables in cards, or nest cards.
- Use a modal where an inline panel or a sheet does the job.
