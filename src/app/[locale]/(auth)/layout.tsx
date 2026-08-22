import { getTranslations } from 'next-intl/server'
import { LocaleSwitcher } from '@/components/shell/locale-switcher'
import { ThemeToggle } from '@/components/shell/theme-toggle'

/**
 * Shell for unauthenticated screens. No navigation — there is nowhere to go
 * until you are signed in, and nav on a login page is just a way to get lost.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE LANGUAGE SWITCHER IS HERE, ON A PAGE WITH NO SESSION.             │
 * │                                                                           │
 * │ A user's preferred_locale is stored on their profile and applied after    │
 * │ sign-in. Before it, the only signal is the URL — so a Gujarati-speaking   │
 * │ kitchen porter handed a link to /en/login had no way to read the form     │
 * │ they were being asked to fill in, and no control that would change it.    │
 * │ Everything else on this screen is decoration; this is the one addition    │
 * │ that changes whether somebody can use the product at all.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The brand panel is deliberately factual — the three restaurants, in their own
 * colours — rather than the usual login-screen marketing. It also happens to be
 * the only place --brand-capiche and --brand-aiko are visible together, which
 * makes it the page to check when the palette changes.
 */

const BRANDS = [
  { name: 'Bookends', className: 'bg-brand-bookends' },
  { name: 'Capiche', className: 'bg-brand-capiche' },
  { name: 'AIKO', className: 'bg-brand-aiko' },
]

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('app')

  return (
    <div className="flex min-h-svh flex-col lg:flex-row">
      {/* ── Brand panel: lg and up ─────────────────────────────────────────── */}
      <aside className="relative hidden overflow-hidden border-r bg-sidebar lg:flex lg:w-[44%] lg:flex-col lg:justify-between lg:p-12">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundImage:
              'radial-gradient(32rem 24rem at 20% 0%, var(--brand-bookends), transparent 62%),' +
              'radial-gradient(26rem 20rem at 90% 100%, var(--brand-capiche), transparent 58%)',
            opacity: 0.14,
          }}
        />

        <div className="relative flex items-center gap-2.5">
          <span className="grid size-9 place-items-center rounded-xl bg-primary text-sm font-bold text-primary-foreground">
            B
          </span>
          <span className="font-heading text-lg font-semibold tracking-tight">{t('name')}</span>
        </div>

        <div className="relative space-y-6">
          <p className="max-w-sm font-heading text-3xl leading-tight font-semibold tracking-tight text-balance">
            {t('tagline')}
          </p>
          <ul className="flex flex-wrap gap-2">
            {BRANDS.map((brand) => (
              <li
                key={brand.name}
                className="flex items-center gap-2 rounded-full border bg-card/60 py-1 pr-3 pl-2 text-sm"
              >
                <span aria-hidden className={`size-2 rounded-full ${brand.className}`} />
                {brand.name}
              </li>
            ))}
          </ul>
        </div>

        <p className="relative text-xs text-muted-foreground">
          {new Date().getFullYear()} · {t('name')}
        </p>
      </aside>

      {/* ── Form column ──────────────────────────────────────────────────────
          data-auth-surface raises every control inside to a 44px touch target —
          see the box in globals.css.

          It is on the COLUMN and not on <main>, which is where it started. The
          header's theme toggle and language switcher measured 28px tall in
          Chrome, and the language switcher is the one control on this screen a
          Gujarati speaker must find before they can read anything else. */}
      <div data-auth-surface className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-1 p-4">
          <ThemeToggle />
          <LocaleSwitcher />
        </header>

        <main className="flex flex-1 items-center justify-center px-6 pt-2 pb-14">
          <div className="w-full max-w-sm space-y-6">
            {/* The wordmark the brand panel carries above lg. */}
            <div className="flex items-center justify-center gap-2.5 lg:hidden">
              <span className="grid size-8 place-items-center rounded-xl bg-primary text-xs font-bold text-primary-foreground">
                B
              </span>
              <span className="font-heading font-semibold tracking-tight">{t('name')}</span>
            </div>

            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
