import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, buttonVariants } from "@orbitid/ui";
import { Monitor, Moon, Sun } from "lucide-react";

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const current = theme === "system" ? "system" : resolvedTheme ?? theme ?? "light";
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={buttonVariants({ variant: "ghost", size: "icon" })} aria-label="Toggle theme">
          {mounted && current === "dark" ? <Moon aria-hidden /> : <Sun aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setTheme("light")}>
          <Sun aria-hidden /> Light
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("dark")}>
          <Moon aria-hidden /> Dark
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => setTheme("system")}>
          <Monitor aria-hidden /> System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
