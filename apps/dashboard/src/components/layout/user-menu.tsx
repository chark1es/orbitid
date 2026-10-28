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
import { ChevronsUpDown, LogOut, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "../../lib/auth";
import { getApiUrl, getSecretKey } from "../../lib/api";
import { UserAvatar } from "../shared/user-avatar";

export function UserMenu() {
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const secretKey = getSecretKey();
  const keyKind = secretKey.startsWith("sk_live_") ? "Live secret key" : "Test secret key";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={buttonVariants({ variant: "ghost", className: "h-9 gap-2 px-1.5 sm:px-2" })}>
          <UserAvatar name="Instance admin" size="sm" />
          <span className="hidden text-sm font-medium sm:inline">Admin</span>
          <ChevronsUpDown className="hidden size-3.5 text-muted-foreground sm:inline" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel className="flex items-center gap-2 font-normal">
          <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
          <span className="flex min-w-0 flex-col">
            <span className="text-sm font-medium">Instance admin</span>
            <span className="truncate text-xs text-muted-foreground">{keyKind}</span>
          </span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
          <span className="block truncate">API: {getApiUrl()}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => {
            signOut();
            toast.success("Signed out");
            navigate("/login", { replace: true, state: { from: location.pathname } });
          }}
        >
          <LogOut aria-hidden /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
