import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
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
import { Search } from "lucide-react";
import type { UserJSON } from "@orbitid/shared";
import { useApi } from "../../lib/api";
import { useDebounced } from "../../lib/hooks";
import { primaryEmail, userLabel } from "../../lib/format";
import { UserAvatar } from "../shared/user-avatar";
import { ALL_NAV_ITEMS } from "./nav";

export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebounced(search.trim(), 250);
  const enabled = debounced.length >= 2;

  const { data, isFetching } = useApi<{ data: UserJSON[] }>(
    ["command-users", debounced],
    `/users?query=${encodeURIComponent(debounced)}&limit=5&order_by=-created_at&paginated=true`,
    { enabled },
  );

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

  const go = (href: string) => {
    setOpen(false);
    setSearch("");
    navigate(href);
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 w-7 justify-center gap-2 px-0 text-muted-foreground sm:w-52 sm:justify-start sm:px-2"
        onClick={() => setOpen(true)}
        aria-label="Search pages and users"
      >
        <Search className="size-3.5 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left text-[0.8125rem] font-normal sm:inline">Search</span>
        <kbd className="hidden h-4.5 items-center rounded-xs border border-border bg-muted px-1 font-data text-[0.6875rem] text-muted-foreground sm:inline-flex">
          ⌘K
        </kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search pages and users">
        <CommandInput placeholder="Search pages or users…" value={search} onValueChange={setSearch} />
        <CommandList>
          <CommandEmpty>{isFetching ? "Searching…" : "No results. Try a name, an email, or a page."}</CommandEmpty>
          {enabled && (data?.data?.length ?? 0) > 0 ? (
            <>
              <CommandGroup heading="Users">
                {data?.data?.map((user) => {
                  const label = userLabel(user);
                  const email = primaryEmail(user);
                  return (
                    <CommandItem
                      key={user.id}
                      value={`${label} ${email} ${user.id}`}
                      onSelect={() => go(`/users/${user.id}`)}
                    >
                      <UserAvatar name={label} imageUrl={user.image_url} size="sm" className="size-6" />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{label}</span>
                        {email ? <span className="truncate text-xs text-muted-foreground">{email}</span> : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
              <CommandSeparator />
            </>
          ) : null}
          <CommandGroup heading="Navigate">
            {ALL_NAV_ITEMS.map((item) => (
              <CommandItem key={item.href} value={`${item.title} ${item.href}`} onSelect={() => go(item.href)}>
                <item.icon className="size-4 text-muted-foreground" aria-hidden />
                {item.title}
              </CommandItem>
            ))}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </>
  );
}
