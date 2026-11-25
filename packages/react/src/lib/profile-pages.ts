import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

/**
 * Props of `<UserProfile.Page>` and `<OrganizationProfile.Page>`.
 *
 * - With `url`, the element adds a custom page at that position in the navigation. A `url` equal to a built-in
 *   page id (`"billing"`) overrides that built-in page: the custom page takes its place entirely, including who
 *   may see it (built-in permission checks no longer apply; gate your own content).
 * - Without `url`, `label` names a built-in page (`"profile"`, `"security"`, `"billing"`, …). The element then
 *   places that page at its position, hides it (`hidden`), or replaces its content (`children`), keeping the
 *   built-in label and the built-in access rules (a gated page stays gated).
 */
export interface ProfilePageProps {
  /** Navigation label of a custom page, or the id of a built-in page. */
  label: string;
  /** URL slug of a custom page (`"team"` → `#/team` or `/user-profile/team`). Leave it out for a built-in page. */
  url?: string;
  /** Icon shown next to the label. */
  labelIcon?: ReactNode;
  /** With a built-in `label`: remove that page from the navigation. */
  hidden?: boolean;
  /** Page content. With a built-in `label`, it replaces the built-in content. */
  children?: ReactNode;
}

/** Props of `<UserProfile.Link>` and `<OrganizationProfile.Link>`: an external entry in the navigation. */
export interface ProfileLinkProps {
  label: string;
  /** Absolute or relative href. */
  url: string;
  labelIcon?: ReactNode;
}

export type ParsedProfileItem =
  | { type: "builtin"; id: string; hidden: boolean; icon?: ReactNode; content?: ReactNode }
  | { type: "page"; id: string; label: string; icon?: ReactNode; content: ReactNode }
  | { type: "link"; id: string; label: string; icon?: ReactNode; url: string };

export interface ParsedProfileChildren {
  items: ParsedProfileItem[];
  /** Built-in pages the children replace with their own content, by id. */
  customContent: ReadonlySet<string>;
  /** Built-in pages the children hide, by id. */
  hidden: ReadonlySet<string>;
  /** Built-in pages a custom page (with the same `url`) overrides, by id. */
  overridden: ReadonlySet<string>;
}

/** Strips leading and trailing slashes from a page slug. */
export function normalizePageSlug(value: string): string {
  return value.trim().replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Element children in order, with fragments (`<>…</>`, often used for conditional pages) flattened. Shared by every
 * component that reads `Page`/`Link` children, so they all see the same elements.
 */
export function flattenChildren(children: ReactNode): ReactElement[] {
  const out: ReactElement[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === Fragment) out.push(...flattenChildren((child.props as { children?: ReactNode }).children));
    else out.push(child);
  });
  return out;
}

/**
 * Whether `children` renders anything: `false`, `true`, `null`, empty strings and arrays, and fragments holding only
 * those do not count, so `{show && <Billing />}` with `show` false leaves the built-in page in place.
 */
export function hasRenderableContent(children: ReactNode): boolean {
  return Children.toArray(children).some((child) => {
    if (isValidElement(child) && child.type === Fragment) {
      return hasRenderableContent((child.props as { children?: ReactNode }).children);
    }
    return typeof child === "string" ? child.trim() !== "" : true;
  });
}

/**
 * Reads `Page`/`Link` children in order. `builtInIds` lists every built-in page the component can render, so a
 * reference to one that is currently unavailable (still loading, or not permitted) is still recognized.
 */
export function parseProfileChildren(
  children: ReactNode,
  pageType: unknown,
  linkType: unknown,
  builtInIds: readonly string[],
): ParsedProfileChildren {
  const items: ParsedProfileItem[] = [];
  const customContent = new Set<string>();
  const hidden = new Set<string>();
  const overridden = new Set<string>();
  const seen = new Set<string>();
  for (const child of flattenChildren(children)) {
    if (child.type === pageType) {
      const props = child.props as ProfilePageProps;
      const slug = props.url ? normalizePageSlug(props.url) : "";
      if (!slug) {
        // A built-in reference; the first reference to a page wins.
        if (!builtInIds.includes(props.label) || seen.has(props.label)) continue;
        seen.add(props.label);
        const hasContent = hasRenderableContent(props.children);
        if (props.hidden) hidden.add(props.label);
        else if (hasContent) customContent.add(props.label);
        items.push({
          type: "builtin",
          id: props.label,
          hidden: Boolean(props.hidden),
          icon: props.labelIcon,
          content: hasContent ? props.children : undefined,
        });
        continue;
      }
      // Two pages may not share a slug: the first one wins. A custom page at a built-in slug overrides it.
      if (seen.has(slug)) continue;
      seen.add(slug);
      if (builtInIds.includes(slug)) overridden.add(slug);
      // A page without a label would be a blank navigation button; its slug names it instead.
      const label = props.label?.trim() || slug;
      items.push({ type: "page", id: slug, label, icon: props.labelIcon, content: props.children });
      continue;
    }
    if (child.type === linkType) {
      const props = child.props as ProfileLinkProps;
      const url = props.url?.trim();
      // Links are keyed by URL, so the first link to a URL wins, like pages; a link without a URL goes nowhere.
      if (!url || seen.has(`link:${url}`)) continue;
      seen.add(`link:${url}`);
      items.push({ type: "link", id: `link:${url}`, label: props.label?.trim() || url, icon: props.labelIcon, url });
    }
  }
  return { items, customContent, hidden, overridden };
}

/** A built-in page the component can show right now (already filtered by availability and permissions). */
export interface BuiltInProfilePage {
  id: string;
  label: string;
  icon?: ReactNode;
  content: ReactNode;
}

export type ProfileNavEntry =
  | { type: "page"; id: string; label: string; icon?: ReactNode; content: ReactNode; builtIn: boolean }
  | { type: "link"; id: string; label: string; icon?: ReactNode; url: string };

/**
 * The navigation in display order: built-in pages the children do not mention come first, in their default
 * order; then every child in the order written (built-in references, custom pages, links). Hidden and
 * unavailable built-in pages are left out.
 */
export function resolveProfileNav(builtIns: readonly BuiltInProfilePage[], parsed: ParsedProfileChildren): ProfileNavEntry[] {
  const referenced = new Set(
    parsed.items.filter((item) => item.type === "builtin" || parsed.overridden.has(item.id)).map((item) => item.id),
  );
  const entries: ProfileNavEntry[] = builtIns
    .filter((page) => !referenced.has(page.id))
    .map((page) => ({ type: "page", id: page.id, label: page.label, icon: page.icon, content: page.content, builtIn: true }));
  for (const item of parsed.items) {
    if (item.type === "builtin") {
      if (item.hidden) continue;
      const page = builtIns.find((candidate) => candidate.id === item.id);
      if (!page) continue;
      entries.push({
        type: "page",
        id: page.id,
        label: page.label,
        icon: item.icon ?? page.icon,
        content: item.content ?? page.content,
        builtIn: true,
      });
    } else if (item.type === "page") {
      entries.push({ type: "page", id: item.id, label: item.label, icon: item.icon, content: item.content, builtIn: false });
    } else {
      entries.push(item);
    }
  }
  return entries;
}

/**
 * `url` when it is an absolute https URL, otherwise `null`. The server only stores https billing-portal URLs;
 * this keeps a stray value (an older row, a misbehaving proxy) from ever becoming a `javascript:` link.
 */
export function safeHttpsUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}
