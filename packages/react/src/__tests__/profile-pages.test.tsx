import { describe, expect, it } from "vitest";
import {
  hasRenderableContent,
  normalizePageSlug,
  parseProfileChildren,
  resolveProfileNav,
  safeHttpsUrl,
  type BuiltInProfilePage,
  type ProfileLinkProps,
  type ProfilePageProps,
} from "../lib/profile-pages";

function Page(_: ProfilePageProps) {
  return null;
}
function Link(_: ProfileLinkProps) {
  return null;
}

const BUILT_INS = ["profile", "security", "billing"] as const;
const builtIns: BuiltInProfilePage[] = [
  { id: "profile", label: "Profile", content: "profile-content" },
  { id: "security", label: "Security", content: "security-content" },
  { id: "billing", label: "Billing", content: "billing-content" },
];

function resolve(children: React.ReactNode, available = builtIns) {
  const parsed = parseProfileChildren(children, Page, Link, BUILT_INS);
  return { parsed, nav: resolveProfileNav(available, parsed) };
}

describe("profile pages", () => {
  it("keeps the default order when there are no children", () => {
    expect(resolve(null).nav.map((entry) => entry.id)).toEqual(["profile", "security", "billing"]);
  });

  it("appends custom pages and links after the built-in pages, in the order written", () => {
    const { nav } = resolve(
      <>
        <Page label="Team" url="/team/">
          team
        </Page>
        <Link label="Docs" url="https://docs.example.com" />
      </>,
    );
    expect(nav.map((entry) => entry.label)).toEqual(["Profile", "Security", "Billing", "Team", "Docs"]);
    expect(nav[3]).toMatchObject({ type: "page", id: "team", builtIn: false, content: "team" });
    expect(nav[4]).toMatchObject({ type: "link", url: "https://docs.example.com" });
  });

  it("moves referenced built-in pages to where they are written, and hides them", () => {
    const { nav, parsed } = resolve(
      <>
        <Page label="Team" url="team" />
        <Page label="profile" />
        <Page label="security" hidden />
      </>,
    );
    expect(nav.map((entry) => entry.id)).toEqual(["billing", "team", "profile"]);
    expect(parsed.hidden.has("security")).toBe(true);
  });

  it("replaces a built-in page's content but keeps its label and availability", () => {
    const { nav, parsed } = resolve(
      <Page label="billing">
        custom-billing
      </Page>,
    );
    expect(parsed.customContent.has("billing")).toBe(true);
    expect(nav.find((entry) => entry.id === "billing")).toMatchObject({ label: "Billing", content: "custom-billing", builtIn: true });

    // A built-in page that is not available (not permitted) stays out, custom content or not.
    const gated = resolve(<Page label="billing">custom-billing</Page>, builtIns.slice(0, 2)).nav;
    expect(gated.map((entry) => entry.id)).toEqual(["profile", "security"]);
  });

  it("lets a custom page at a built-in slug override that page", () => {
    const { nav, parsed } = resolve(
      <Page label="Plans" url="billing">
        plans
      </Page>,
      builtIns.slice(0, 2),
    );
    expect(parsed.overridden.has("billing")).toBe(true);
    expect(nav.map((entry) => entry.label)).toEqual(["Profile", "Security", "Plans"]);
    expect(nav[2]).toMatchObject({ builtIn: false, content: "plans" });
  });

  it("ignores duplicates, unknown built-in labels and other elements", () => {
    const { nav } = resolve(
      <>
        <Page label="Team" url="team">
          first
        </Page>
        <Page label="Team again" url="team">
          second
        </Page>
        <Page label="unknown" />
        <Page label="profile" />
        <Page label="profile" hidden />
        <div>stray</div>
        text
      </>,
    );
    expect(nav.map((entry) => entry.label)).toEqual(["Security", "Billing", "Team", "Profile"]);
    expect(nav.find((entry) => entry.id === "team")).toMatchObject({ content: "first" });
  });

  it("treats false, true, empty strings and empty arrays as no content", () => {
    const show = false as boolean;
    const { nav, parsed } = resolve(
      <Page label="billing">
        {show && <p>Plans</p>}
      </Page>,
    );
    expect(parsed.customContent.has("billing")).toBe(false);
    expect(nav.find((entry) => entry.id === "billing")).toMatchObject({ content: "billing-content" });
    for (const empty of [false, true, null, undefined, "", "  ", [], [false, null], <>{false}</>]) {
      expect(hasRenderableContent(empty as React.ReactNode)).toBe(false);
    }
    for (const content of ["text", 0, <p key="p">x</p>, [null, "x"], <>{"x"}</>]) {
      expect(hasRenderableContent(content as React.ReactNode)).toBe(true);
    }
  });

  it("names unlabelled entries after their slug or URL, lists a URL once and drops links without one", () => {
    const { nav } = resolve(
      <>
        <Page label="" url="team">
          team
        </Page>
        <Link label="Docs" url="https://docs.example.com" />
        <Link label="Docs again" url="https://docs.example.com" />
        <Link label="  " url="https://help.example.com" />
        <Link label="Nowhere" url="" />
      </>,
    );
    expect(nav.slice(3).map((entry) => entry.label)).toEqual(["team", "Docs", "https://help.example.com"]);
    expect(new Set(nav.map((entry) => entry.id)).size).toBe(nav.length);
  });

  it("normalizes slugs", () => {
    expect(normalizePageSlug(" /team/ ")).toBe("team");
    expect(normalizePageSlug("///")).toBe("");
  });

  it("only turns https URLs into links", () => {
    expect(safeHttpsUrl("https://pay.example.com/portal?x=1")).toBe("https://pay.example.com/portal?x=1");
    expect(safeHttpsUrl("http://pay.example.com")).toBeNull();
    expect(safeHttpsUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpsUrl("/relative")).toBeNull();
    expect(safeHttpsUrl("")).toBeNull();
    expect(safeHttpsUrl(null)).toBeNull();
  });
});
