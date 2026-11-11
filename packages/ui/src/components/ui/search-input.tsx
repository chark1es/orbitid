import { SearchIcon } from "lucide-react"
import { cn } from "../../lib/utils"
import { Input } from "./input"

/**
 * Search field with a leading icon. The icon is centred against the field's own height, so a
 * `size` change on the input cannot leave it a pixel high or low.
 */
function SearchInput({
  className,
  inputClassName,
  iconClassName,
  type = "search",
  ...props
}: React.ComponentProps<"input"> & {
  inputClassName?: string
  iconClassName?: string
}) {
  return (
    <div className={cn("relative w-full", className)}>
      <SearchIcon
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground",
          iconClassName
        )}
      />
      <Input
        type={type}
        className={cn("pl-8 [&::-webkit-search-cancel-button]:appearance-none", inputClassName)}
        {...props}
      />
    </div>
  )
}

export { SearchInput }
