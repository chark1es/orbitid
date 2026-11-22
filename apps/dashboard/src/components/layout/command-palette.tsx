import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@orbitid/ui";
import { CornerDownLeft, Loader2, Search } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { api, useApi } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { primaryEmail, userLabel } from "../../lib/format";
import { OVERLAY_WIDTH } from "../shared/overlay-sizes";
import { UserAvatar } from "../shared/user-avatar";
import { useShowOrganizations } from "../../lib/features";
import { visibleNavGroups } from "./nav";

type UserPage = { data: UserJSON[] };

/** Newest users, fetched once when the palette opens. They answer short queries instantly, before the server does. */
const RECENT_KEY = ["command-users", "recent"];
const RECENT_PATH = "/users?limit=50&order_by=-created_at&paginated=true";
const RESULT_LIMIT = 8;
const SEARCH_DEBOUNCE_MS = 120;

/** Lowercased text a user can be found by: name, username, every email and phone, and the id. */
function searchText(user: UserJSON): string {
  return [
    userLabel(user),
    user.username,
    user.first_name,
    user.last_name,
    user.id,
    ...(user.email_addresses ?? []).map((email) => email.email_address),
    ...(user.phone_numbers ?? []).map((phone) => phone.phone_number),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** Recent users first (they show immediately), then the server's matches for the settled query, without duplicates. */
export function mergeUserResults(term: string, recent: UserJSON[], remote: UserJSON[] | undefined): UserJSON[] {
  const needle = term.trim().toLowerCase();
  if (!needle) return recent.slice(0, 5);
  const seen = new Set<string>();
  const out: UserJSON[] = [];
  const push = (user: UserJSON) => {
    if (seen.has(user.id) || out.length >= RESULT_LIMIT) return;
    seen.add(user.id);
    out.push(user);
  };
  for (const user of remote ?? []) push(user);
  for (const user of recent) if (searchText(user).includes(needle)) push(user);
  return out;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const term = search.trim();
  const debounced = useDebounced(term, SEARCH_DEBOUNCE_MS);
  const remoteEnabled = open && debounced.length >= 2;
  const organizations = useShowOrganizations();
  const navItems = useMemo(
    () => visibleNavGroups({ organizations }).flatMap((group) => group.items),
    [organizations],
  );

  const recent = useApi<UserPage>(RECENT_KEY, RECENT_PATH, { enabled: open, staleTime: 60_000 });
  const remote = useApi<UserPage>(
    ["command-users", debounced],
    `/users?query=${encodeURIComponent(debounced)}&limit=${RESULT_LIMIT}&order_by=-created_at&paginated=true`,
    // Keep the last answer on screen while the next one loads, so the list does not blink empty per keystroke.
    { enabled: remoteEnabled, staleTime: 30_000, placeholderData: keepPreviousData },
  );

  const users = useMemo(
    () => mergeUserResults(term, recent.data?.data ?? [], remoteEnabled ? remote.data?.data : undefined),
    [term, recent.data, remote.data, remoteEnabled],
  );
  const searching = (remoteEnabled && remote.isFetching) || (term.length >= 2 && term !== debounced);

  /** Warm the recent list on hover or focus of the trigger, so it is already there when the palette opens. */
  const prefetch = useCallback(() => {
    void queryClient.prefetchQuery({
      queryKey: RECENT_KEY,
      queryFn: ({ signal }) => api<UserPage>("GET", RECENT_PATH, undefined, signal),
      staleTime: 60_000,
    });
  }, [queryClient]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };

  const go = (href: string) => {
    onOpenChange(false);
    navigate(href);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 justify-center gap-2 px-0 text-muted-foreground lg:w-52 lg:justify-start lg:px-2"
        onClick={() => setOpen(true)}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        aria-label="Search pages and users"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left text-[0.8125rem] font-normal lg:inline">Search</span>
        <kbd className="hidden h-4.5 items-center rounded-sm border border-border bg-muted px-1 font-data text-[0.6875rem] text-muted-foreground lg:inline-flex">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog
        open={open}
        onOpenChange={onOpenChange}
        title="Command palette"
        description="Search pages and users"
        className={OVERLAY_WIDTH.sheet}
      >
        <CommandInput
          placeholder="Search pages or users…"
          value={search}
          onValueChange={setSearch}
          trailing={
            <span className="flex shrink-0 items-center gap-2">
              {searching ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="Searching" />
              ) : null}
              <kbd className="hidden h-5 items-center rounded-sm border border-border bg-muted px-1.5 font-data text-[0.6875rem] text-muted-foreground sm:inline-flex">
                Esc
              </kbd>
            </span>
          }
        />
        <CommandList>
          <CommandEmpty>{searching ? "Searching…" : "No results. Try a name, an email, or a page."}</CommandEmpty>
          {users.length > 0 ? (
            <>
              <CommandGroup heading={term ? "Users" : "Newest users"}>
                {users.map((user) => {
                  const label = userLabel(user);
                  const email = primaryEmail(user);
                  return (
                    <CommandItem
                      key={user.id}
                      // The search text carries every identifier, so cmdk's own filter keeps a server match visible.
                      value={`${user.id} ${searchText(user)}`}
                      onSelect={() => go(`/users/${user.id}`)}
                      className="group/item"
                    >
                      <UserAvatar name={label} imageUrl={user.image_url} size="sm" className="size-7" />
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium">{label}</span>
                        {email ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
                      </span>
                      <CornerDownLeft
                        className="size-3.5! opacity-0 transition-opacity group-data-[selected=true]/item:opacity-100"
                        aria-hidden
                      />
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          <CommandGroup heading="Navigate">
            {navItems.map((item) => (
              <CommandItem
                key={item.href}
                value={`${item.title} ${item.href}`}
                onSelect={() => go(item.href)}
                className="group/item"
              >
                <item.icon className="text-muted-foreground" aria-hidden />
                <span className="flex-1">{item.title}</span>
                <CornerDownLeft
                  className="size-3.5! opacity-0 transition-opacity group-data-[selected=true]/item:opacity-100"
                  aria-hidden
                />
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
