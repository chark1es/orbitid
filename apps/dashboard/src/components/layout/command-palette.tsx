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
    `/users?query=${encodeURIComponent(debounced)}&limit=5&order_by=-created_at`,
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
        className="h-8 w-8 justify-center gap-2 px-0 text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5"
        onClick={() => setOpen(true)}
        aria-label="Search and navigate"
      >
        <Search className="size-4 shrink-0" aria-hidden />
        <span className="hidden flex-1 text-left text-sm sm:inline">Search…</span>
        <kbd className="hidden h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] text-muted-foreground sm:inline-flex">⌘K</kbd>
      </Button>
      <CommandDialog open={open} onOpenChange={setOpen} title="Command palette" description="Search pages and users">
        <CommandInput placeholder="Search pages or users…" value={search} onValueChange={setSearch} />
        <CommandList>
          <CommandEmpty>{isFetching ? "Searching…" : "No results."}</CommandEmpty>
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
