import { Children, Fragment, isValidElement, useState, type ReactNode } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Skeleton,
  cn,
} from "@orbitid/ui";
import { ChevronsUpDownIcon, LogOutIcon, PlusIcon, SettingsIcon, UsersIcon } from "lucide-react";
import { activateSession, currentUser, displayName, initials, primaryIdentifier, signOut } from "../_shared/api";
import { AuthAppearanceScope, useElementClasses, useThemeScope } from "../_shared/appearance";
import { useAuthRuntime } from "../_shared/w6";
import type { UserButtonProps } from "../_shared/types";
import { UserProfile } from "../user-profile";
import { flattenChildren } from "../../../lib/profile-pages";
import { UserVerificationModal } from "../user-verification-modal";

export interface UserButtonActionProps {
  label: string;
  labelIcon?: ReactNode;
  onClick?: () => void;
  /** Opens the manage-account screen at this page (`"billing"`, `"security"`, a custom page's `url`, …). */
  open?: string;
  children?: ReactNode;
}

export interface UserButtonLinkProps {
  label: string;
  labelIcon?: ReactNode;
  href: string;
  children?: ReactNode;
}

function Action(_: UserButtonActionProps) {
  return null;
}

function Link(_: UserButtonLinkProps) {
  return null;
}

function UserButtonMenuItems({ children }: { children?: ReactNode }) {
  return <>{children}</>;
}

function UserAvatar({ user, className }: { user: ReturnType<typeof currentUser>; className?: string }) {
  return (
    <Avatar className={cn("size-8", className)}>
      {user?.image_url ? <AvatarImage src={user.image_url} alt="" /> : null}
      <AvatarFallback className="text-xs font-semibold">{initials(user)}</AvatarFallback>
    </Avatar>
  );
}

function UserButtonInner(props: UserButtonProps) {
  const runtime = useAuthRuntime();
  const { orbit, t } = runtime;
  const { el } = useElementClasses();
  // The menu and the profile dialog are portaled out of the page's tree, so they carry the scheme themselves.
  const { className: themeClass } = useThemeScope();
  const user = currentUser(orbit);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profilePage, setProfilePage] = useState<string | undefined>(undefined);
  const sessions = runtime.client?.sessions ?? [];
  const activeSessionId = runtime.session?.id ?? runtime.client?.last_active_session_id ?? null;
  const multiSession = !runtime.environment.singleSessionMode && sessions.length > 1;

  const customItems: ReactNode[] = (() => {
    const rendered: ReactNode[] = [];
    const renderItem = (node: ReactNode, key: string) => {
      if (!isValidElement(node)) return;
      if (node.type === Action) {
        const item = node.props as UserButtonActionProps;
        rendered.push(
          <DropdownMenuItem
            key={key}
            onSelect={() => {
              if (item.onClick) item.onClick();
              else if (item.open) openProfile(item.open);
            }}
          >
            {item.labelIcon}
            {item.label}
          </DropdownMenuItem>,
        );
        return;
      }
      if (node.type === Link) {
        const item = node.props as UserButtonLinkProps;
        rendered.push(
          <DropdownMenuItem key={key} asChild>
            <a href={item.href} className="flex items-center gap-2">
              {item.labelIcon}
              {item.label}
            </a>
          </DropdownMenuItem>,
        );
        return;
      }
      // Profile pages and links belong to the account screen, not the menu.
      if (node.type === UserProfile.Page || node.type === UserProfile.Link) return;
      if (node.type === UserButtonMenuItems || node.type === Fragment) {
        Children.forEach((node.props as { children?: ReactNode }).children, (child, index) => {
          renderItem(child, `${key}-${index}`);
        });
        return;
      }
      rendered.push(<span key={key}>{node}</span>);
    };
    Children.forEach(props.children, (child, index) => renderItem(child, `custom-${index}`));
    return rendered;
  })();

  const openProfile = (page?: string) => {
    if (props.userProfileMode === "navigation") {
      const base = props.userProfileUrl ?? "/user-profile";
      runtime.navigate(page && page !== "profile" ? `${base.replace(/\/$/, "")}/${page}` : base);
      return;
    }
    setProfilePage(page);
    setProfileOpen(true);
  };

  // `<UserButton.UserProfilePage>` / `.UserProfileLink` children customize the account screen it opens.
  // Read like `<UserProfile>` reads its own children (fragments flattened), then keyed for the array.
  const profileChildren = Children.toArray(
    flattenChildren(props.children).filter(
      (child) => child.type === UserProfile.Page || child.type === UserProfile.Link,
    ),
  );

  const handleSignOut = async () => {
    await signOut(runtime, {
      sessionId: activeSessionId ?? undefined,
      redirectUrl: props.afterSignOutUrl,
    });
  };

  const handleSignOutAll = async () => {
    const ids = sessions.map((session) => session.id);
    if (ids.length === 0) {
      await signOut(runtime, { redirectUrl: props.afterSignOutUrl });
      return;
    }
    for (const id of ids) await signOut(runtime, { sessionId: id });
    if (props.afterSignOutUrl) runtime.navigate(props.afterSignOutUrl, { replace: true });
  };

  const signInUrl =
    typeof orbit.buildSignInUrl === "function" ? orbit.buildSignInUrl() : "/sign-in";

  const handleSwitch = async (sessionId: string) => {
    if (sessionId === activeSessionId) return;
    await activateSession(orbit, sessionId);
    runtime.refresh();
    if (props.afterSwitchSessionUrl) runtime.navigate(props.afterSwitchSessionUrl);
  };

  const profilePanel = (
    <UserProfile
      {...props.userProfileProps}
      routing="virtual"
      __modal
      defaultPage={profilePage ?? props.userProfileProps?.defaultPage}
      appearance={{ ...props.appearance, ...props.userProfileProps?.appearance }}
    >
      {props.userProfileProps?.children}
      {profileChildren}
    </UserProfile>
  );

  if (!runtime.loaded) return <Skeleton className="size-8 rounded-full" aria-label={t("common.loading")} />;
  if (!user) return null;

  return (
    <div className={cn("inline-flex", el("userButtonBox"))}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            className={cn("h-auto gap-2 rounded-full p-1 pe-2", !props.showName && "pe-1", el("userButtonTrigger"))}
            aria-label={t("userButton.account")}
          >
            <span className={cn(el("userButtonAvatarBox"))}>
              <UserAvatar user={user} />
            </span>
            {props.showName ? (
              <span className={cn("max-w-[10rem] truncate text-sm font-medium", el("userButtonOuterIdentifier"))}>
                {displayName(user)}
              </span>
            ) : null}
            <ChevronsUpDownIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className={cn(themeClass, "w-64", el("menuList"))}>
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center gap-2 py-1">
              <UserAvatar user={user} className="size-9" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{displayName(user)}</p>
                <p className="truncate text-xs text-muted-foreground">{primaryIdentifier(user)}</p>
              </div>
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => openProfile()} className="gap-2">
            <SettingsIcon className="size-4" aria-hidden="true" />
            {t("userButton.manageAccount")}
          </DropdownMenuItem>
          {customItems}
          {multiSession ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t("userButton.switchSession")}
              </DropdownMenuLabel>
              {sessions.map((session) => {
                const publicUser = session.public_user_data;
                const label =
                  [publicUser?.first_name, publicUser?.last_name].filter(Boolean).join(" ") ||
                  publicUser?.identifier ||
                  session.id;
                return (
                  <DropdownMenuItem
                    key={session.id}
                    onSelect={() => void handleSwitch(session.id).catch(() => undefined)}
                    className="gap-2"
                    data-testid={`session-${session.id}`}
                  >
                    <Avatar className="size-5">
                      {publicUser?.image_url ? <AvatarImage src={publicUser.image_url} alt="" /> : null}
                      <AvatarFallback className="text-[0.6875rem]">
                        {(publicUser?.first_name?.charAt(0) ?? publicUser?.identifier?.charAt(0) ?? "?").toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <span className="truncate">{label}</span>
                    {session.id === activeSessionId ? (
                      <span className="ms-auto text-[0.6875rem] text-muted-foreground">{t("userProfile.devices.current")}</span>
                    ) : null}
                  </DropdownMenuItem>
                );
              })}
            </>
          ) : null}
          <DropdownMenuItem
            onSelect={() =>
              runtime.navigate(`${signInUrl}${signInUrl.includes("?") ? "&" : "?"}prompt=select_account`)
            }
            className="gap-2"
            data-testid="user-button-add-account"
          >
            <PlusIcon className="size-4" aria-hidden="true" />
            {t("userButton.addAccount")}
          </DropdownMenuItem>
          {multiSession ? (
            <DropdownMenuItem onSelect={() => void handleSignOutAll().catch(() => undefined)} className="gap-2 text-destructive">
              <UsersIcon className="size-4" aria-hidden="true" />
              {t("userButton.signOutAll")}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => void handleSignOut().catch(() => undefined)}
            className="gap-2"
            data-testid="user-button-sign-out"
          >
            <LogOutIcon className="size-4" aria-hidden="true" />
            {t("userButton.signOut")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {profileOpen ? (
        <>
          <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
            <DialogContent className={cn(themeClass, "max-h-[90vh] w-full max-w-3xl overflow-y-auto p-0")} showCloseButton>
              <DialogHeader className="sr-only">
                <DialogTitle>{t("userProfile.title")}</DialogTitle>
                <DialogDescription>{t("userProfile.subtitle")}</DialogDescription>
              </DialogHeader>
              {profilePanel}
            </DialogContent>
          </Dialog>
        </>
      ) : null}

      <UserVerificationModal />
    </div>
  );
}

function UserButtonBase(props: UserButtonProps) {
  return (
    <AuthAppearanceScope appearance={props.appearance}>
      <UserButtonInner {...props} />
    </AuthAppearanceScope>
  );
}

export const UserButton = Object.assign(UserButtonBase, {
  MenuItems: UserButtonMenuItems,
  Action,
  Link,
  /** A `<UserProfile.Page>` for the account screen the button opens. */
  UserProfilePage: UserProfile.Page,
  /** A `<UserProfile.Link>` for the account screen the button opens. */
  UserProfileLink: UserProfile.Link,
});
