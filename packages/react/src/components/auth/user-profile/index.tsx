import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Button,
  Card,
  Separator,
} from "@orbitid/ui";
import { AppWindowIcon, BuildingIcon, CreditCardIcon, KeyRoundIcon, ShieldCheckIcon, UserIcon } from "lucide-react";
import { currentUser, displayName, primaryIdentifier } from "../_shared/api";
import { AuthAppearanceScope, useComponentElements } from "../_shared/appearance";
import { ComponentRoot } from "../_shared/component-root";
import { organizationsEnabled } from "../../../hooks/internal/organizationFeature";
import {
  parseProfileChildren,
  resolveProfileNav,
  type BuiltInProfilePage,
  type ProfileLinkProps,
  type ProfilePageProps,
} from "../../../lib/profile-pages";
import { AuthCard } from "../_shared/auth-card";
import { useAuthRuntime } from "../_shared/w6";
import { USER_PROFILE_PAGES, type UserProfileProps } from "../_shared/types";
import { useStep } from "../_shared/use-step";
import { ProfilePage } from "./profile-page";
import { SecurityPage } from "./security-page";
import { ApplicationsPage, BillingPage, OrganizationsPage, useUserApplications } from "./account-pages";
import { UserVerificationModal } from "../user-verification-modal";
import { AuthLoadingScreen } from "../_shared/loading";

/** `<UserProfile.Page>`: a custom page, or a reference to a built-in page (see {@link ProfilePageProps}). */
export type UserProfilePageProps = ProfilePageProps;
/** `<UserProfile.Link>`: an external entry in the navigation. */
export type UserProfileLinkProps = ProfileLinkProps;

function UserProfilePage(_: UserProfilePageProps) {
  return null;
}

function UserProfileLink(_: UserProfileLinkProps) {
  return null;
}

/**
 * The API keys page, loaded lazily. `settled` turns true once the import finished either way, so a failed chunk
 * load (a stale page after a redeploy) stops the deep link from waiting and falls back to the first page.
 */
function useApiKeysComponent(): { component: ComponentType | null; settled: boolean } {
  const [state, setState] = useState<{ component: ComponentType | null; settled: boolean }>({
    component: null,
    settled: false,
  });
  useEffect(() => {
    let cancelled = false;
    void import("../../org")
      .then((module) => {
        if (cancelled) return;
        const candidate: unknown = Reflect.get(module, "APIKeys");
        setState({ component: typeof candidate === "function" ? (candidate as ComponentType) : null, settled: true });
      })
      .catch(() => {
        if (!cancelled) setState({ component: null, settled: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

function UserProfileInner(props: UserProfileProps) {
  const runtime = useAuthRuntime();
  const { orbit, t, environment } = runtime;
  const { ep } = useComponentElements();
  const user = currentUser(orbit);
  const { component: ApiKeys, settled: apiKeysSettled } = useApiKeysComponent();
  const { applications, loaded: applicationsLoaded } = useUserApplications(orbit, user?.id ?? null);
  const parsed = parseProfileChildren(props.children, UserProfilePage, UserProfileLink, USER_PROFILE_PAGES);
  const icon = (Icon: typeof UserIcon) => <Icon className="size-4" aria-hidden="true" />;
  // The security page links to other pages; `useStep` runs after the navigation is known.
  const navigateRef = useRef<(page: string) => void>(() => undefined);

  // Built-in pages in their default order. Organizations shows when the feature is on; Apps when the user may use
  // at least one OAuth application; Billing when the developer supplied billing content or an app has a portal.
  const builtIns: BuiltInProfilePage[] = [
    { id: "profile", label: t("userProfile.nav.profile"), icon: icon(UserIcon), content: <ProfilePage /> },
    {
      id: "security",
      label: t("userProfile.nav.security"),
      icon: icon(ShieldCheckIcon),
      content: <SecurityPage onNavigate={(page) => navigateRef.current(page)} />,
    },
  ];
  if (organizationsEnabled(orbit.environment)) {
    builtIns.push({ id: "organizations", label: t("userProfile.nav.organization"), icon: icon(BuildingIcon), content: <OrganizationsPage /> });
  }
  if (applications.length > 0) {
    builtIns.push({ id: "apps", label: t("userProfile.nav.apps"), icon: icon(AppWindowIcon), content: <ApplicationsPage applications={applications} /> });
  }
  if (parsed.customContent.has("billing") || applications.some((app) => app.billingUrl)) {
    builtIns.push({ id: "billing", label: t("userProfile.nav.billing"), icon: icon(CreditCardIcon), content: <BillingPage applications={applications} /> });
  }
  if (ApiKeys) {
    builtIns.push({ id: "api-keys", label: t("userProfile.apiKeys.title"), icon: icon(KeyRoundIcon), content: <ApiKeys /> });
  }
  const nav = resolveProfileNav(builtIns, parsed);
  const pages = nav.filter((entry) => entry.type === "page");
  const links = nav.filter((entry) => entry.type === "link");
  // Every page the component can render is a valid step, so a deep link or `defaultPage` to a page that is still
  // loading (Apps, Billing, API keys) survives until it appears.
  const stepIds = [
    ...USER_PROFILE_PAGES,
    ...parsed.items.filter((item) => item.type === "page").map((item) => item.id),
  ];
  const firstPage = pages[0]?.id ?? "profile";

  const { step, setStep } = useStep<string>({
    routing: props.__modal ? "virtual" : props.routing ?? "path",
    path: props.path ?? "/user-profile",
    steps: stepIds,
    initialStep: props.defaultPage && stepIds.includes(props.defaultPage) ? props.defaultPage : firstPage,
    slugFor: (page) => (page === "profile" ? "" : page),
  });
  navigateRef.current = setStep;

  if (!runtime.loaded) return <AuthLoadingScreen />;

  if (!user) {
    return (
      <div className="flex w-full items-center justify-center p-4">
        <AuthCard title={t("userProfile.title")}>
          <p className="text-center text-sm text-muted-foreground">{t("userProfile.profile.noUser")}</p>
        </AuthCard>
      </div>
    );
  }

  // A page that is still loading shows nothing yet; one that will not appear falls back to the first page.
  const pending = (!applicationsLoaded && (step === "apps" || step === "billing")) || (step === "api-keys" && !ApiKeys && !apiKeysSettled);
  const activePage = pages.find((page) => page.id === step) ?? (pending ? undefined : pages[0]);
  const title = activePage?.label ?? t("userProfile.title");

  const navigation = (
    <nav
      aria-label={t("userProfile.title")}
      {...ep(
        ["userProfileNavbar", "navbar"],
        "flex shrink-0 gap-1 overflow-x-auto border-b bg-muted/50 p-2 [scrollbar-width:none] md:w-56 md:flex-col md:overflow-visible md:border-e md:border-b-0 md:p-3 [&::-webkit-scrollbar]:hidden",
      )}
    >
      <div className="hidden px-2 pt-1 pb-4 md:block">
        <p className="truncate text-sm font-heading">{t("userProfile.title")}</p>
        <p className="truncate text-xs text-muted-foreground">{environment.app.name}</p>
      </div>
      {pages.map((entry) => {
        const active = activePage?.id === entry.id;
        return (
          <Button
            key={entry.id}
            type="button"
            variant="ghost"
            size="sm"
            aria-current={active ? "page" : undefined}
            data-active={active ? "true" : undefined}
            onClick={() => setStep(entry.id)}
            {...ep(
              "navbarButton",
              "h-8 shrink-0 justify-start gap-2.5 px-2.5 text-muted-foreground hover:text-foreground md:w-full",
              active && "bg-card text-foreground shadow-xs ring-1 ring-border hover:bg-card",
            )}
          >
            <span {...ep("navbarButtonIcon", "flex", active ? "text-foreground" : "text-muted-foreground")}>{entry.icon}</span>
            {entry.label}
          </Button>
        );
      })}
      {links.length > 0 ? (
        <>
          <Separator className="my-2 hidden md:block" />
          {links.map((link) => (
            <Button
              key={link.id}
              asChild
              variant="ghost"
              size="sm"
              {...ep("navbarButton", "h-8 shrink-0 justify-start gap-2.5 px-2.5 text-muted-foreground hover:text-foreground md:w-full")}
            >
              <a href={link.url} target="_blank" rel="noreferrer">
                <span className="text-muted-foreground">{link.icon}</span>
                {link.label}
              </a>
            </Button>
          ))}
        </>
      ) : null}
    </nav>
  );

  const page = (
    <div {...ep(["userProfilePage", "pageScrollBox"], "flex min-w-0 flex-1 flex-col gap-6 p-5 sm:p-8")}>
      <header className="flex flex-col gap-0.5 border-b pb-5">
        <h1 {...ep("headerTitle", "truncate text-lg font-heading tracking-[-0.01em]")}>{title}</h1>
        <p className="truncate text-sm text-muted-foreground">
          {displayName(user)}
          {primaryIdentifier(user) ? ` · ${primaryIdentifier(user)}` : ""}
        </p>
      </header>
      {activePage ? <div data-orbit-page={activePage.id}>{activePage.content}</div> : null}
    </div>
  );

  const panel = (
    <div {...ep("userProfile", "flex w-full flex-col md:min-h-[32rem] md:flex-row")}>
      {navigation}
      {page}
    </div>
  );

  return (
    <>
      {props.__modal ? (
        <ComponentRoot component="user-profile" className="flex w-full">
          {panel}
          <UserVerificationModal />
        </ComponentRoot>
      ) : (
        <ComponentRoot component="user-profile" className="flex w-full justify-center px-4 py-6">
          <Card {...ep("cardBox", "w-full max-w-4xl gap-0 overflow-hidden rounded-xl py-0 shadow-card")}>{panel}</Card>
          <UserVerificationModal />
        </ComponentRoot>
      )}
    </>
  );
}

function UserProfileBase(props: UserProfileProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <UserProfileInner {...props} />
    </AuthAppearanceScope>
  );
}

export const UserProfile = Object.assign(UserProfileBase, {
  Page: UserProfilePage,
  Link: UserProfileLink,
});
