import { useLocation, useNavigate } from "react-router-dom";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  buttonVariants,
} from "@orbitid/ui";
import { ChevronsUpDown, LogOut, ShieldCheck, UserRound } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../../lib/auth";
import { ApiError, getApiUrl } from "../../lib/api";

export function UserMenu() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={buttonVariants({ variant: "ghost", size: "sm", className: "gap-2 pl-1 pr-1.5" })}
          aria-label="Instance menu"
        >
          <UserRound className="size-4 text-muted-foreground sm:hidden" aria-hidden />
          <span className="hidden text-[0.8125rem] font-medium sm:inline">Admin</span>
          <ChevronsUpDown className="hidden size-3.5 text-muted-foreground sm:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-start gap-2 font-normal">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Instance admin</span>
            <span className="text-xs text-muted-foreground">Operator session</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="font-data text-[0.6875rem] font-normal text-muted-foreground">
          <span className="block truncate">{getApiUrl()}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            void signOut().then(
              () => {
                toast.success("Signed out");
                navigate("/login", { replace: true, state: { from: location.pathname } });
              },
              (cause: unknown) => {
                // Revocation failed, so the cookie is still live. Say so instead of pretending to sign out.
                toast.error("Could not sign out", {
                  description:
                    cause instanceof ApiError
                      ? cause.message
                      : "The server did not answer. Your session is still active; try again.",
                });
              },
            );
          }}
        >
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
