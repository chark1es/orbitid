"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { useElementSlot } from "../../lib/element-slots"

function Table({ className, style, ...props }: React.ComponentProps<"table">) {
  const slot = useElementSlot(["table"], "w-full caption-bottom border-collapse text-sm", className, style, props)
  return (
    <div
      data-slot="table-container"
      className="relative w-full overflow-x-auto"
    >
      <table
        data-slot="table"
        className={slot.className}
        style={slot.style}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, style, ...props }: React.ComponentProps<"thead">) {
  const slot = useElementSlot(["tableHeader"], "[&_tr]:border-b [&_tr]:border-border", className, style, props)
  return (
    <thead
      data-slot="table-header"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function TableBody({ className, style, ...props }: React.ComponentProps<"tbody">) {
  const slot = useElementSlot(["tableBody"], "[&_tr:last-child]:border-0", className, style, props)
  return (
    <tbody
      data-slot="table-body"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn(
        "border-t border-border bg-muted/50 font-medium [&>tr]:last:border-b-0",
        className
      )}
      {...props}
    />
  )
}

function TableRow({ className, style, ...props }: React.ComponentProps<"tr">) {
  const slot = useElementSlot(["tableRow"], "border-b border-border transition-colors hover:bg-muted/50 data-[state=selected]:bg-muted data-[state=selected]:hover:bg-muted/80", className, style, props)
  return (
    <tr
      data-slot="table-row"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function TableHead({ className, style, ...props }: React.ComponentProps<"th">) {
  const slot = useElementSlot(["tableHead"], "h-9 px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:align-middle", className, style, props)
  return (
    <th
      data-slot="table-head"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function TableCell({ className, style, ...props }: React.ComponentProps<"td">) {
  const slot = useElementSlot(["tableCell"], "px-3 py-2.5 align-middle leading-5 whitespace-nowrap [&:has([role=checkbox])]:pr-0 [&>[role=checkbox]]:align-middle", className, style, props)
  return (
    <td
      data-slot="table-cell"
      className={slot.className}
      style={slot.style}
      {...props}
    />
  )
}

function TableCaption({
  className,
  ...props
}: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-4 text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
  TableCaption,
}
