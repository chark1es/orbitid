import { Children, isValidElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Button,
  Card,
  CardContent,
  Separator,
  cn,
} from "@orbitid/ui";
import { KeyRoundIcon, ShieldCheckIcon, UserIcon } from "lucide-react";
import { currentUser, displayName, primaryIdentifier } from "../_shared/api";
import { AuthAppearanceScope, useElementClasses, useResolvedTheme } from "../_shared/appearance";
import { contrastForeground } from "../../../appearance";
import { AuthCard } from "../_shared/auth-card";
import { useAuthRuntime } from "../_shared/w6";
import type { UserProfileProps } from "../_shared/types";
import { useStep } from "../_shared/use-step";
import { ProfilePage } from "./profile-page";
import { SecurityPage } from "./security-page";
import { UserVerificationModal } from "../user-verification-modal";
import { AuthLoadingScreen } from "../_shared/loading";

export interface UserProfilePageProps {
  label: string;
  url: string;
  labelIcon?: ReactNode;
  children?: ReactNode;
}

export interface UserProfileLinkProps {
  label: string;
  url: string;
  labelIcon?: ReactNode;
}

function UserProfilePage(_: UserProfilePageProps) {
  return null;
}

function UserProfileLink(_: UserProfileLinkProps) {
  return null;
}

interface NavEntry {
  id: string;
  label: string;
  icon?: ReactNode;
}

interface ParsedChildren {
  pages: UserProfilePageProps[];
  links: UserProfileLinkProps[];
}

function parseChildren(children: ReactNode): ParsedChildren {
  const pages: UserProfilePageProps[] = [];
  const links: UserProfileLinkProps[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === UserProfilePage) pages.push(child.props as UserProfilePageProps);
    else if (child.type === UserProfileLink) links.push(child.props as UserProfileLinkProps);
  });
  return { pages, links };
}

function useApiKeysComponent(): ComponentType | null {
  const [component, setComponent] = useState<ComponentType | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import("../../org")
      .then((module) => {
        if (cancelled) return;
        const candidate: unknown = Reflect.get(module, "APIKeys");
        if (typeof candidate === "function") setComponent(() => candidate as ComponentType);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);
  return component;
}

function UserProfileInner(props: UserProfileProps) {
  const runtime = useAuthRuntime();
  const { orbit, t, environment } = runtime;
  const { el, appearance, cssVariables, primaryColor, rootClassName } = useElementClasses();
  const resolvedTheme = useResolvedTheme();
  const brandingStyle: Record<string, string> = { ...cssVariables };
  if (!appearance.variables.colorPrimary) {
    brandingStyle["--primary"] = primaryColor;
    brandingStyle["--ring"] = primaryColor;
    const foreground = contrastForeground(primaryColor);
    if (foreground) brandingStyle["--primary-foreground"] = foreground;
  }
  const user = currentUser(orbit);
  const { pages, links } = parseChildren(props.children);
  const ApiKeys = useApiKeysComponent();

  const defaultNav: NavEntry[] = [
    { id: "profile", label: t("userProfile.nav.profile"), icon: <UserIcon className="size-4" aria-hidden="true" /> },
    { id: "security", label: t("userProfile.nav.security"), icon: <ShieldCheckIcon className="size-4" aria-hidden="true" /> },
  ];
  const apiKeysNav: NavEntry[] = ApiKeys
    ? [{ id: "api-keys", label: t("userProfile.apiKeys.title"), icon: <KeyRoundIcon className="size-4" aria-hidden="true" /> }]
    : [];
  const nav: NavEntry[] = [
    ...defaultNav,
    ...apiKeysNav,
    ...pages.map((page) => ({ id: page.url, label: page.label, icon: page.labelIcon })),
  ];

  const { step, setStep } = useStep<string>({
    routing: props.__modal ? "virtual" : props.routing ?? "path",
    path: props.path ?? "/user-profile",
    steps: nav.map((entry) => entry.id),
    initialStep: props.defaultPage && nav.some((entry) => entry.id === props.defaultPage) ? props.defaultPage : "profile",
    slugFor: (page) => (page === "profile" ? "" : page),
  });

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

  const activePage = pages.find((page) => page.url === step);
  const title = nav.find((entry) => entry.id === step)?.label ?? t("userProfile.title");

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
            "-mx-1 flex shrink-0 gap-1 overflow-x-auto px-1 pb-1 md:mx-0 md:w-44 md:flex-col md:overflow-visible md:px-0 md:pb-0",
            el("userProfileNavbar"),
            el("navbar"),
          )}
        >
          {nav.map((entry) => (
            <Button
              key={entry.id}
              type="button"
              variant={step === entry.id ? "secondary" : "ghost"}
              size="sm"
              aria-current={step === entry.id ? "page" : undefined}
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
                <Button key={link.url} asChild variant="ghost" size="sm" className="shrink-0 justify-start gap-2 md:w-full">
                  <a href={link.url} target="_blank" rel="noreferrer">
                    <span className="text-muted-foreground">{link.labelIcon}</span>
                    {link.label}
                  </a>
                </Button>
              ))}
            </>
          ) : null}
        </nav>
        <div className={cn("min-w-0 flex-1", el("userProfilePage"), el("pageScrollBox"))}>
          {step === "profile" ? <ProfilePage onNavigate={setStep} /> : null}
          {step === "security" ? <SecurityPage onNavigate={setStep} /> : null}
          {step === "api-keys" && ApiKeys ? <ApiKeys /> : null}
          {activePage ? <div data-orbit-page={activePage.url}>{activePage.children}</div> : null}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{environment.app.name}</p>
    </div>
  );

  return (
    <>
      {props.__modal ? (
        <div className={cn(resolvedTheme === "dark" && "dark", rootClassName, "p-5 sm:p-6")} style={brandingStyle} data-orbit-theme={resolvedTheme}>
          {panel}
        </div>
      ) : (
        <div className={cn(resolvedTheme === "dark" && "dark", rootClassName, "flex w-full justify-center px-4 py-6")} style={brandingStyle} data-orbit-theme={resolvedTheme}>
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
