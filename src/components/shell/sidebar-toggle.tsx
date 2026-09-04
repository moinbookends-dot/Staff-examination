'use client'

import { useState } from 'react'
import { PanelLeftCloseIcon, PanelLeftOpenIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Open/close the desktop sidebar.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A COOKIE AND A DOM ATTRIBUTE, NOT REACT STATE IN THE LAYOUT.              │
 * │                                                                           │
 * │ The shell is a Server Component and should stay one. So the server reads  │
 * │ the `sidebar` cookie and stamps data-sidebar on the wrapper — the choice  │
 * │ is in the first HTML frame, no flash on reload — and this button flips    │
 * │ the attribute in place for the instant version of the same truth. One    │
 * │ CSS rule in globals.css does the hiding. The useState here is only so    │
 * │ the icon and label track the flip without re-rendering the layout.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * md+ only: below md there is no sidebar to close — the tab bar and the
 * mobile menu are the navigation there.
 */
export function SidebarToggle({
  initiallyClosed,
  hideLabel,
  showLabel,
}: {
  initiallyClosed: boolean
  hideLabel: string
  showLabel: string
}) {
  const [closed, setClosed] = useState(initiallyClosed)

  const toggle = () => {
    const next = !closed
    setClosed(next)
    document.querySelector('[data-app-surface]')?.setAttribute(
      'data-sidebar',
      next ? 'closed' : 'open',
    )
    // A year: a layout preference, not a session. Path=/ so every page agrees.
    document.cookie = `sidebar=${next ? 'closed' : 'open'};path=/;max-age=31536000;samesite=lax`
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label={closed ? showLabel : hideLabel}
      aria-expanded={!closed}
      aria-controls="app-sidebar"
      className="hidden md:inline-flex"
    >
      {closed ? <PanelLeftOpenIcon /> : <PanelLeftCloseIcon />}
    </Button>
  )
}
