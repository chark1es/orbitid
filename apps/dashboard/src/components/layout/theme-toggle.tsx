import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, buttonVariants } from "@orbitid/ui";
import { Check, Monitor, Moon, Sun } from "lucide-react";

const OPTIONS = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
] as const;

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const active = theme ?? "system";
  const shown = active === "system" ? resolvedTheme : active;
  const TriggerIcon = shown === "dark" ? Moon : Sun;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={buttonVariants({ variant: "ghost", size: "icon-sm", className: "text-muted-foreground" })}
          aria-label={`Theme: ${mounted ? active : "system"}`}
          title="Theme"
        >
          <TriggerIcon aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {OPTIONS.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => setTheme(option.value)}>
            <option.icon aria-hidden />
            <span className="flex-1">{option.label}</span>
            {mounted && active === option.value ? <Check aria-hidden className="size-3.5 text-signal" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
