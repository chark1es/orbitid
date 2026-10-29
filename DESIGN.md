---
name: OrbitID
description: Self-hosted authentication you run on your own Postgres, set like a railway timetable.
colors:
  paper: "oklch(0.975 0.006 85)"
  card: "oklch(0.992 0.004 85)"
  ink: "oklch(0.2 0.01 60)"
  ink-muted: "oklch(0.48 0.012 70)"
  rule: "oklch(0.88 0.008 85)"
  rail: "oklch(0.2 0.008 60)"
  rail-ink: "oklch(0.93 0.006 85)"
  signal: "oklch(0.58 0.235 28)"
  go: "oklch(0.55 0.15 150)"
  caution: "oklch(0.74 0.15 80)"
  info: "oklch(0.55 0.12 245)"
  paper-dark: "oklch(0.17 0.008 60)"
  card-dark: "oklch(0.21 0.008 60)"
  ink-dark: "oklch(0.94 0.006 85)"
  rule-dark: "oklch(0.32 0.01 60)"
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
    fontWeight: 600
    lineHeight: 1.4
  control:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 500
    lineHeight: 1.4
  figure:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.75rem"
    fontWeight: 650
    lineHeight: 1.1
  body:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
  heading:
    fontFamily: "Hanken Grotesk Variable, Helvetica Neue, Arial, sans-serif"
    fontSize: "1.375rem"
    fontWeight: 650
    lineHeight: 1.2
    letterSpacing: "-0.015em"
  data:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "0.8125rem"
    fontWeight: 450
    lineHeight: 1.4
rounded:
  pill: "999px"
  sm: "3px"
  md: "4px"
  lg: "6px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "20px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.md}"
    height: "34px"
    padding: "0 14px"
  button-danger:
    backgroundColor: "{colors.signal}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    height: "34px"
    padding: "0 14px"
  line-code:
    backgroundColor: "{colors.rail}"
    textColor: "{colors.rail-ink}"
    rounded: "{rounded.sm}"
    size: "22px"
---

# Design system

## Overview

OrbitID is a tool operated by developers and by support staff, so the screen is a working product first. The world it borrows from is a Swiss railway timetable: a warm paper ground, black grotesque type, strict columns, and one signal red that is kept for the active item and for things that need attention. The world lends type, palette, density and one signature move. It never supplies the layout, the navigation model or the controls, which are the standard web components an operator already knows.

Product truth that the design must keep visible: the instance lives in the operator's own database, at the operator's own URL. Both appear in the top bar on every screen.

Surface mode: Operate (dashboard) and Operate (test website). Light and dark themes are both first class. Dark is chosen by the operator, never forced.

## Colors

Restrained palette with one committed region: the navigation rail is charcoal in both themes.

- Ground is warm paper, not white. Cards sit one step lighter than the ground, separated by a 1px rule, never by a shadow.
- Ink is a warm near-black. Muted ink is used for secondary labels only and always meets 4.5:1 on paper.
- Signal red marks the active navigation item, the selected row, destructive actions and failures. Nothing decorative is red.
- Go green, caution amber and info blue exist only as status. Status is never color alone: it always carries a word or a shape.
- Chart series use ink and signal red first, then ink-muted. No rainbow palettes.

## Typography

One family carries the interface: Hanken Grotesk (variable, self-hosted). JetBrains Mono carries ids, keys, timestamps, claims and code, and nothing else. Numbers in tables and counters use tabular figures (`font-variant-numeric: tabular-nums`).

Fixed rem scale at a 1.125 ratio: 0.6875 (captions inside chips and rail labels), 0.75 (column headers and labels), 0.8125 (data), 0.875 (body), 0.9375 (prominent controls), 1, 1.125, 1.375 (page title), 1.75 (large figure), 2.25. No fluid type. Body measure for prose is 65 to 75 characters. Headings are weight 650, tracking -0.015em. Column headers are 0.75rem, weight 600, uppercase with +0.04em tracking, and sit in the row they head; there are no eyebrow labels above headings.

## Layout

- Shell: 232px charcoal rail on the left (grouped navigation, instance name at the top, sign-out and theme at the bottom), 48px paper top bar (breadcrumb, instance chip, command search), content on paper. Content is fluid to a 1280px maximum with 24px gutters.
- Spacing is a 4px base. Tight groups use 4 to 8px, sibling blocks 20px, sections 32px, with more space above a heading than below it.
- The rail collapses to an icon strip below 1024px and to a sheet below 768px. Tables become stacked rows below 640px.
- Tables are the primary object. Row height 40px, 1px rule between rows, no zebra, no card around a table that already has a border.
- Page structure is title row (title, one-line description, primary action), then filters, then the data. No hero metric template, no grid of identical icon cards.

## Elevation & Depth

Depth is declared once: a 1px rule. Cards, tables and inputs have a border and no shadow. Overlays (popover, dialog, sheet, command palette) get one soft shadow with a real offset and blur, and sit on the same border. There are no glows, no gradients, no blur as decoration.

## Shapes

Near-square. Controls and tables use 4px, small chips and line codes 3px, cards and dialogs 6px. Pills are used only for the smallest status chips. No colored side-borders on cards or alerts.

## Components

All stock shadcn/ui primitives from `packages/ui`, restyled through tokens only. Every interactive component has default, hover, focus-visible (2px signal ring offset by 2px), active, disabled, loading and error states.

- Buttons: primary is ink on paper (inverted in dark), secondary is a ruled outline, destructive is signal red. One primary action per view.
- Inputs: 34px, 1px rule, ink focus ring, error text states the problem and the fix.
- Status chip: a word plus a 6px dot, for example `Active`, `Banned`, `MFA`, `Failed`. Never a colored dot alone.
- Empty states say what the screen will contain and give the next action, in a sentence.
- Skeletons for loading, never a centered spinner over content.
- Icons: lucide, 1.5px stroke, 16px, one style everywhere.

### Signature move: the activity board

Recent sign-ins, sessions and webhook deliveries are set like a departures board. Strict columns: time (mono, tabular, `14:02`), line code, who (name over identifier), where (device and place), outcome (word plus dot). The line code is a 22px charcoal square carrying one letter for the method: P password, E email code, M email link, S SMS, K passkey, O OAuth, T authenticator, B backup code, X SSO. A failed attempt turns the line code signal red. New rows appear at the top with a 160ms ease-out slide and a one-time red hairline that fades. The board appears on Overview (live), on a user's Activity tab and in the test website's Inspector. It is built from a normal table, with real column headers, so it stays accessible.

## Do's and Don'ts

Do
- Show real instance data: counts, methods, keys, the database in use and the URL.
- Keep red scarce. If more than one thing per screen is red, something is wrong.
- Use sentence case everywhere. Name the action on every button.
- Mark dangerous actions (impersonate, delete, rotate key) with a plain sentence of what happens.
- Respect `prefers-reduced-motion`: the board's slide becomes an instant swap.

Don't
- Mention other vendors' products in the interface or in copy.
- Add an eyebrow label above a heading, gradient text, glass, glows, or hard offset shadows.
- Use emoji or Unicode glyphs as icons, or monospace as decoration.
- Wrap tables in cards, or nest cards.
- Use a modal where an inline panel or a sheet does the job.
