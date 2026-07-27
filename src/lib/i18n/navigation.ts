import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

/**
 * Locale-aware navigation primitives.
 *
 * ALWAYS import Link, redirect, useRouter and usePathname from here — never
 * from `next/link` or `next/navigation` directly. These wrappers keep the
 * active locale prefix on every URL; the raw Next equivalents drop it, which
 * silently bounces the user back to the default locale mid-session.
 *
 * This is the single easiest thing to get wrong in a localised App Router
 * project, and the symptom (language resets on some links but not others)
 * looks like a state bug rather than an import bug.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing)
