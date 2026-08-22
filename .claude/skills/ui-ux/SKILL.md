---
name: ui-ux
description: The design system and UI conventions for this app — tokens, typography roles, the shared primitives in src/components/ui, locale-aware navigation, the three-language rule, touch targets on signed-out screens, and the render checks that pin them. Read this BEFORE writing or changing any screen, component, layout, or styling — including "just one small class". Triggers on: new page, new component, Tailwind classes, colours, spacing, dark mode, empty states, status badges, forms, tables, dialogs, toasts, accessibility, responsive layout.
---

# Building UI in this app

This file is the DESIGN.md that `globals.css`, both layouts, `question-list.tsx`
and `history-list.tsx` all reference and that has never existed in the repo. The
design system was documented only in CSS comments; this is it written down.

**Stack:** Next.js 16.2.12 (App Router), React 19.2.4, Tailwind v4, shadcn/ui on
Base UI, next-intl 4, lucide-react icons, sonner for toasts.

---

## 1. The four rules that fail silently

These do not throw. They ship, and somebody finds out later.

### Import `Link` and `redirect` from the i18n wrapper, never from Next

```ts
import { Link, redirect, useRouter, usePathname } from '@/lib/i18n/navigation'  // ✅
import Link from 'next/link'                                                    // ❌
```

The wrappers keep the active locale prefix on every URL. The raw Next
equivalents drop it and bounce the user back to the default locale mid-session.
The symptom — "the language resets on some links but not others" — reads like a
state bug, not an import bug.

### Every user-facing string goes through next-intl, in all three languages

`messages/en.json`, `messages/hi.json`, `messages/gu.json`. A key added to one
and not the others is a missing string in production, not a fallback.

- Server Component: `const t = await getTranslations('reports')`
- Client Component: `const t = useTranslations('profile')`
- Dates and numbers: `getFormatter()` / `useFormatter()`, never `toLocaleString`

Top-level namespaces already in use: `app, common, auth, questions, exams, nav,
errors, sitting, evaluation, results, reports, translations, dashboard, bank,
shell, papers, import, profile, notifications`.

### Some labels must stay bare text nodes

`scripts/render-check.mjs` asserts on `>Label<` patterns rather than
`includes('Label')` — because next-intl serialises the whole message bundle into
every page, so `includes` is always true and would prove nothing.

Putting an icon or a `<span>` between an element's `>` and the first character
of its label silently breaks those assertions. It applies to:

- `PageHeader` `title`
- `StatTile` `label`
- `EmptyState` `message`

An icon passed as `actions`, or as a *preceding* sibling, is fine. Run
`npm run check:render` after touching any of these.

### No data is not zero

A null pass rate renders as an empty state, never as `0%`. "0% pass rate" says
everybody failed — a different and far more alarming claim than "nobody has sat
this yet", and the difference matters most to the person it is about. Use `—`
for a single absent figure, `EmptyState` for an absent set.

---

## 2. Tokens, not values

There is **no `tailwind.config.js`**. This is Tailwind v4 — every token is
defined in [src/app/globals.css](../../../src/app/globals.css) under
`@theme inline`, and consumed as a normal utility. Changing a value there
repaints the whole app without touching a component. Writing a raw value at a
call site opts that element out of the system permanently.

```tsx
<div className="bg-card text-muted-foreground rounded-xl">   // ✅
<div className="bg-[#fff] text-[#71717a] rounded-[24px]">    // ❌
```

### Colour has two separate scales, and mixing them is a bug

| Scale | Tokens | Means |
|---|---|---|
| **Outcome** | `success` `warning` `info` `destructive` | What happened — passed, pending, failed |
| **Brand** | `brand-bookends` `brand-capiche` `brand-aiko` | Which restaurant a row belongs to |

Never colour a status with a brand token or vice versa. That separation is what
lets red keep meaning "failed" instead of "Capiche". `--warning` is a dark amber
and deliberately **not** AIKO Yellow — a brand mark that also means "something is
wrong" is a mark you cannot use.

Every outcome token is used two ways: as a solid fill under its
`-foreground`, and as *text* on a 12–20% tint of itself (the badge variants).
The second is the binding constraint and all values are measured to clear
4.5:1 in both roles, in both themes. If you introduce a colour, measure it both
ways before using it.

### Shape

Absolute values, not multiples of one `--radius`. The two that carry the look:

- `rounded` (8px) — buttons, inputs, chips
- `rounded-xl` (24px) — cards, dashboard widgets

### Typography is roles, not sizes

Seven utilities in `globals.css`: `text-display-lg`, `text-headline-lg`,
`text-title-md`, `text-body-md`, `text-body-sm`, `text-label-caps`. Write the
role; never respell it as `text-[32px] font-semibold tracking-[-0.01em]`. Spelled
out at each call site they drift, and the interface stops looking like one
system. `text-headline-lg` carries its own mobile size in a media query, so a
page cannot use the desktop size on a phone by forgetting a responsive variant.

`text-label-caps` is the one role that changes typeface — JetBrains Mono,
uppercase, wide tracking, for metadata, IDs, status chips and table headers.
Never for prose.

> **Known drift, don't propagate it.** Adoption is partial: `text-display-lg`
> and `surface-1` are used in **zero** components, and `PageHeader` still writes
> `text-2xl font-semibold tracking-tight` by hand. Prefer the role utility in new
> work. If you are already editing a component that spells a role out, convert it.

### Elevation

`surface-1` is a 1px border **and** an ambient shadow — not one or the other. The
border does the work in dark mode and in print where the shadow vanishes; the
shadow does it in light mode where a bare border reads as a wireframe.

`glass` (frosted chrome) is deliberately **not** applied to `/attempt/[id]`.
Translucency costs contrast and that page is a timed assessment.

### The font stack already handles Hindi and Gujarati

`--font-sans` lists Latin, Devanagari and Gujarati faces together. A browser
picks a face per glyph, so a Hindi question inside an otherwise-English screen —
which the Question Bank does, showing all three languages at once — renders
correctly with **no per-locale class**. Never add one.

---

## 3. Use the primitives before writing markup

[src/components/ui/](../../../src/components/ui/) — check here first:

`alert` `alert-dialog` `avatar` `backend-required` `badge` `button` `card`
`checkbox` `data-table` `dialog` `dropdown-menu` `empty-state` `inline-error`
`input` `label` `page-header` `radio-group` `select` `separator` `skeleton`
`sonner` `stat-tile` `switch` `table` `tabs` `textarea`

Most exist because the same markup had been hand-written on a dozen pages and
had already drifted. `PageHeader` replaced fourteen hand-rolled headers that
disagreed on gap and heading size. Re-hand-rolling one restarts that.

Composition patterns worth copying:

- **Page shell:** `<div className="space-y-6">` → `PageHeader` → content
- **Stat row:** `grid gap-4 sm:grid-cols-2 lg:grid-cols-4` of `StatTile`
- **Empty list inside a card:** `<Card><CardContent className="p-0"><EmptyState …/></CardContent></Card>`
- **Numbers:** always `tabular-nums`. A column of scores that jumps left and right as digits change is measurably harder to scan.

### `EmptyState`'s `action` is permission-gated

Pass `action` **only** when the viewer can actually perform it. An empty state
offering "New exam" to somebody without `exams.create` is worse than no empty
state: it teaches them the product is broken when the click 403s.

That is the general rule for gating UI — decide *what to draw* from
`can(claims, '…')`, and let the database enforce it regardless:

```tsx
const claims = await requirePermission('reports.read_own')
const seesTeam = can(claims, 'reports.read_team') || can(claims, 'reports.read_all')
```

---

## 4. Forms

Client component, `useActionState`, server action from `src/server/actions/`:

```tsx
'use client'
const [state, formAction, pending] = useActionState<Result | null, FormData>(
  async (_prev, formData) => updateMyProfile({ … }),
  null,
)
<form action={formAction} className="space-y-4">
  {state && !state.ok && <InlineError>{state.message}</InlineError>}
  <div className="space-y-2">
    <Label htmlFor="fullName">{t('fullName')}</Label>
    <Input id="fullName" name="fullName" disabled={pending} required />
  </div>
</form>
```

- **Always `InlineError`** for form-level failures. It carries `role="alert"`,
  an implicit live region — a swapped-in plain `<p>` is invisible to a screen
  reader because focus never moves and nothing announces.
- **Every `Input` needs a `Label` with `htmlFor`.**
- **Disable controls while `pending`.**
- **Success needs `role="status"`.**
- **Facts are not disabled inputs.** Read-only attributes (email, role, outlet)
  render as a `<dl>`, not greyed-out fields. A disabled input looks temporarily
  unavailable — people click it, then hunt for the thing that unlocks it.
- `toast` from `sonner` is for *background* outcomes (import finished, exam
  published), not for validation errors on a form the user is looking at.

---

## 5. Signed-out screens have a different floor: 44px

`login`, `register`, `verify-email`, `reset-password`, `forgot-password`.

The shared `Input` is 32px and `Button lg` is 36px — a density choice that is
fine for managers at a desk. On the auth screens it is the first thing a kitchen
porter touches, one-handed, mid-shift, often with wet hands, and getting it
wrong three times locks the account. So the auth layout's `<main>` carries
`data-auth-surface`, and `globals.css` raises everything inside it to 44px —
Apple's and Google's published minimum.

Consequences when working on those screens:

- Keep `data-auth-surface` on the auth layout. Removing it silently drops every target back to 32px.
- The rule uses `min-height`, so a control that needs to be taller still can be.
- Standalone links are controls and get 44px too; a link inside a `<p>` is prose and is exempt (`:not(p a)`). Don't wrap a real action in a paragraph.
- 320px (iPhone SE) is the floor. Nothing may scroll sideways there.
- Verify with `npm run check:touch` — it measures `getBoundingClientRect()` in headless Chrome, because a class name is not a size.

---

## 6. Accessibility rules already in force

- Decorative icons: `aria-hidden`. Icons are `size-4` inline, `size-5` in an empty-state medallion.
- A bare progress bar needs `role="img"` + `aria-label` with the actual figure.
- `prefers-reduced-motion` is honoured globally — nothing in the app may depend on an animation completing.
- The focus ring is the **brand** colour, not a neutral, so keyboard users get the same visual language as everyone else. Never remove `outline-ring/50`.
- Charts separate by **hue**, not lightness, so `/reports` survives printing and deuteranopia. The dark ramp is lifted, not reused — a chart identical in both themes is invisible in one.

---

## 7. Next.js 16 specifics

This is not the Next you may remember. Per `AGENTS.md`, read
`node_modules/next/dist/docs/` before writing framework code.

- **`params` and `searchParams` are Promises.** `const { id } = await params`.
- **Middleware is now Proxy** — one `src/proxy.ts`, not `middleware.ts`.
- **Server Components are the default.** 62 of 136 components are `'use client'`; add the directive only for state, effects, or event handlers. Fetch on the server and pass data down.
- Routes live under `src/app/[locale]/(app)/…` and `src/app/[locale]/(auth)/…`.

---

## 8. Before you call it done

```bash
npm run lint
npm run typecheck
npm run check:render     # the >Label< assertions
npm run check:shell      # nav and shell
npm run check:touch      # 44px targets — needs `npm run dev` running
npm test
```

`check:render` and `check:touch` are the two that catch UI regressions nothing
else will. Run them if you touched a header, a stat tile, an empty state, or
anything on a signed-out screen.
