import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  Button,
  Card,
  CardContent,
  Separator,
  cn,
} from "@orbitid/ui";
import { AppWindowIcon, BuildingIcon, CreditCardIcon, KeyRoundIcon, ShieldCheckIcon, UserIcon } from "lucide-react";
import { currentUser, displayName, primaryIdentifier } from "../_shared/api";
import { AuthAppearanceScope, useElementClasses, useThemeScope } from "../_shared/appearance";
import { contrastForeground, LIGHT_FOREGROUND } from "../../../appearance";
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
  const { el, appearance, cssVariables, primaryColor, rootClassName } = useElementClasses();
  const { theme: resolvedTheme, className: themeClass } = useThemeScope();
  const brandingStyle: Record<string, string> = { ...cssVariables };
  if (!appearance.variables.colorPrimary) {
    const foreground = contrastForeground(primaryColor);
    // A dark brand color would vanish on the dark surface, so dark mode keeps the theme tokens.
    const vanishesOnDark = resolvedTheme === "dark" && foreground === LIGHT_FOREGROUND;
    if (!vanishesOnDark) {
      brandingStyle["--primary"] = primaryColor;
      brandingStyle["--ring"] = primaryColor;
      if (foreground) brandingStyle["--primary-foreground"] = foreground;
    }
  }
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

  const panel = (
    <div className={cn("flex w-full flex-col gap-4", el("userProfile"))}>
      <header className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className={cn("truncate text-lg font-semibold", el("headerTitle"))}>{title}</h1>
          <p className="truncate text-sm text-muted-foreground">
            {displayName(user)}
            {primaryIdentifier(user) ? ` · ${primaryIdentifier(user)}` : ""}
          </p>
        </div>
      </header>
      <div className="flex flex-col gap-4 md:flex-row md:gap-6">
        <nav
          aria-label={t("userProfile.title")}
          className={cn(
            "flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:w-44 md:flex-col md:overflow-visible md:px-0 md:pb-0",
            el("userProfileNavbar"),
            el("navbar"),
          )}
        >
          {pages.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant={activePage?.id === entry.id ? "secondary" : "ghost"}
              size="sm"
              aria-current={activePage?.id === entry.id ? "page" : undefined}
              onClick={() => setStep(entry.id)}
              className={cn("shrink-0 justify-start gap-2 md:w-full", el("navbarButton"))}
            >
              <span className={cn("text-muted-foreground", el("navbarButtonIcon"))}>{entry.icon}</span>
              {entry.label}
            </Button>
          ))}
          {links.length > 0 ? (
            <>
              <Separator className="my-1 hidden md:block" />
              {links.map((link) => (
                <Button key={link.id} asChild variant="ghost" size="sm" className="shrink-0 justify-start gap-2 md:w-full">
                  <a href={link.url} target="_blank" rel="noreferrer">
                    <span className="text-muted-foreground">{link.icon}</span>
                    {link.label}
                  </a>
                </Button>
              ))}
            </>
          ) : null}
        </nav>
        <div className={cn("min-w-0 flex-1", el("userProfilePage"), el("pageScrollBox"))}>
          {activePage ? <div data-orbit-page={activePage.id}>{activePage.content}</div> : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{environment.app.name}</p>
    </div>
  );

  return (
    <>
      {props.__modal ? (
        <div className={cn(themeClass, rootClassName, "p-5 sm:p-6")} style={brandingStyle} data-orbit-theme={resolvedTheme}>
          {panel}
        </div>
      ) : (
        <div className={cn(themeClass, rootClassName, "flex w-full justify-center px-4 py-6")} style={brandingStyle} data-orbit-theme={resolvedTheme}>
          <Card className={cn("w-full max-w-4xl", el("card"))}>
            <CardContent className="p-5 sm:p-6">{panel}</CardContent>
          </Card>
        </div>
      )}
      <UserVerificationModal />
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
