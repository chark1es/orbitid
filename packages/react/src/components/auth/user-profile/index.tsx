import { Children, isValidElement, useEffect, useState, type ComponentType, type ReactNode } from "react";
import {
  Button,
  Card,
  Separator,
} from "@orbitid/ui";
import { KeyRoundIcon, ShieldCheckIcon, UserIcon } from "lucide-react";
import { currentUser, displayName, primaryIdentifier } from "../_shared/api";
import { AuthAppearanceScope, useComponentElements } from "../_shared/appearance";
import { ComponentRoot } from "../_shared/component-root";
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
  const { ep } = useComponentElements();
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
      {nav.map((entry) => {
        const active = step === entry.id;
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
              key={link.url}
              asChild
              variant="ghost"
              size="sm"
              {...ep("navbarButton", "h-8 shrink-0 justify-start gap-2.5 px-2.5 text-muted-foreground hover:text-foreground md:w-full")}
            >
              <a href={link.url} target="_blank" rel="noreferrer">
                <span className="text-muted-foreground">{link.labelIcon}</span>
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
      {step === "profile" ? <ProfilePage /> : null}
      {step === "security" ? <SecurityPage onNavigate={setStep} /> : null}
      {step === "api-keys" && ApiKeys ? <ApiKeys /> : null}
      {activePage ? <div data-orbit-page={activePage.url}>{activePage.children}</div> : null}
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
