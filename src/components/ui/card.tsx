import * as React from "react"

import { cn } from "@/lib/utils"

/**
 * Level 1 in the elevation scale.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `surface-1`, NOT `ring-1 ring-foreground/10`.                            │
 * │                                                                           │
 * │ A Tailwind ring IS a box-shadow. So the previous treatment — a ring and   │
 * │ no shadow — gave the card no elevation at all in light mode, and gave it  │
 * │ nothing whatsoever on a printed page, where box-shadows do not render.    │
 * │ Papers and answer keys from this app get printed and taped up in a        │
 * │ kitchen, so a card that vanishes when printed loses its edge entirely.    │
 * │                                                                           │
 * │ `surface-1` is the design system's answer: a REAL 1px border plus the     │
 * │ ambient --shadow-surface. The border does the work in dark mode and in    │
 * │ print; the shadow does it in light mode, where a bare border reads as a   │
 * │ wireframe. It also carries the radius and --card background, so the       │
 * │ rounded-xl and bg-card this replaced are not lost.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function Card({
  className,
  size = "default",
  ...props
}: React.ComponentProps<"div"> & { size?: "default" | "sm" }) {
  return (
    <div
      data-slot="card"
      data-size={size}
      className={cn(
        "group/card surface-1 flex flex-col gap-(--card-spacing) overflow-hidden py-(--card-spacing) text-sm text-card-foreground [--card-spacing:--spacing(4)] has-data-[slot=card-footer]:pb-0 has-[>img:first-child]:pt-0 data-[size=sm]:[--card-spacing:--spacing(3)] data-[size=sm]:has-data-[slot=card-footer]:pb-0 *:[img:first-child]:rounded-t-xl *:[img:last-child]:rounded-b-xl",
        className
      )}
      {...props}
    />
  )
}

function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-xl px-(--card-spacing) has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

function CardTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-title"
      className={cn(
        "font-heading text-base leading-snug font-medium group-data-[size=sm]/card:text-sm",
        className
      )}
      {...props}
    />
  )
}

function CardDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

function CardAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-action"
      className={cn(
        "col-start-2 row-span-2 row-start-1 self-start justify-self-end",
        className
      )}
      {...props}
    />
  )
}

function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-content"
      className={cn("px-(--card-spacing)", className)}
      {...props}
    />
  )
}

function CardFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card-footer"
      className={cn(
        "flex items-center rounded-b-xl border-t bg-muted/50 p-(--card-spacing)",
        className
      )}
      {...props}
    />
  )
}

export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
}
