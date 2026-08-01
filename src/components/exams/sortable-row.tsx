'use client'

import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripVerticalIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * One draggable row, with a handle.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DRAG IS AN ENHANCEMENT HERE, NOT THE MECHANISM.                           │
 * │                                                                           │
 * │ The section builder shipped with Move up / Move down buttons, and they    │
 * │ stay. They are the accessible path — real buttons, real labels, reachable │
 * │ by tab — and M10 adds pointer dragging beside them rather than replacing  │
 * │ them with it.                                                             │
 * │                                                                           │
 * │ That ordering matters. Building drag first and then bolting on a keyboard │
 * │ fallback is how the fallback ends up subtly different from the real       │
 * │ thing; both paths call moveItem(), so they cannot diverge.                │
 * │                                                                           │
 * │ dnd-kit's own keyboard sensor is deliberately NOT enabled. It would put   │
 * │ a second keyboard reordering mechanism on the same rows as the buttons,   │
 * │ with different keys and a different mental model, and a screen reader     │
 * │ user would meet both.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The handle carries aria-hidden and tabIndex={-1}: it is a pointer affordance
 * only, and announcing "drag handle" to somebody who already has Move up and
 * Move down beside it is noise, not help.
 */
export function SortableRow({
  id,
  disabled,
  children,
  className,
}: {
  id: string
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled,
  })

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn(
        'relative',
        // Lifted rather than hidden while dragging: a row that vanishes leaves
        // the reader guessing what they are holding.
        isDragging && 'z-10 opacity-80 shadow-lg',
        className,
      )}
      {...attributes}
    >
      {!disabled && (
        <span
          {...listeners}
          aria-hidden
          tabIndex={-1}
          className="absolute top-4 -left-1 cursor-grab touch-none text-muted-foreground/60 hover:text-foreground active:cursor-grabbing"
        >
          <GripVerticalIcon className="size-4" />
        </span>
      )}
      {children}
    </div>
  )
}
