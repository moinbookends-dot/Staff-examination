import { getTranslations } from 'next-intl/server'
import { redirect, Link } from '@/lib/i18n/navigation'
import { getUser } from '@/lib/supabase/server'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  SmartphoneIcon,
  ZapIcon,
  LanguagesIcon,
  ChefHatIcon,
} from 'lucide-react'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The landing page.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS ROUTE USED TO BE A BARE REDIRECT — "an internal tool with no          │
 * │ anonymous audience". The rebrand to Performix changed the premise: the    │
 * │ product now has a name, a mark, and a front door to show them on.         │
 * │                                                                           │
 * │ Signed-in staff never see it. The redirect they always had comes first,   │
 * │ so the page costs them nothing — and every check that asserts "signed-in  │
 * │ lands on /dashboard" holds unchanged.                                     │
 * │                                                                           │
 * │ Everything claimed below is shipped behaviour, deliberately: offline      │
 * │ answer durability, instant auto-grading, three languages, recipe-aware    │
 * │ generation. A landing page that oversells an internal tool to its own     │
 * │ staff would just teach them the copy lies.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const FEATURES = [
  { icon: SmartphoneIcon, title: 'f1Title', body: 'f1Body' },
  { icon: ZapIcon, title: 'f2Title', body: 'f2Body' },
  { icon: LanguagesIcon, title: 'f3Title', body: 'f3Body' },
  { icon: ChefHatIcon, title: 'f4Title', body: 'f4Body' },
] as const

/** The other two locales, for the switcher — the third is the page itself. */
const LOCALES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी' },
  { code: 'gu', label: 'ગુજરાતી' },
]

export default async function RootPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const user = await getUser()

  // Staff go straight in, exactly as before the landing page existed.
  if (user) redirect({ href: '/dashboard', locale })

  const t = await getTranslations('landing')
  const ta = await getTranslations('app')

  return (
    <div className="flex min-h-svh flex-col bg-background">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header className="pt-safe px-safe">
        <div className="mx-auto flex h-16 w-full max-w-5xl items-center justify-between px-4">
          <span className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-white p-1 shadow-sm">
              {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
              <img src="/brand/performix-mark.png" alt="" className="size-7" />
            </span>
            <span className="font-heading text-lg font-semibold tracking-tight">{ta('name')}</span>
          </span>

          <Link
            href="/login"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-11 px-4')}
          >
            {t('signIn')}
          </Link>
        </div>
      </header>

      {/* ── Hero ───────────────────────────────────────────────────────── */}
      <main className="flex-1">
        <section className="relative overflow-hidden">
          {/* The auth layout's ambient wash, in the new brand's own inks. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(36rem 26rem at 15% 0%, #3b2fed, transparent 60%),' +
                'radial-gradient(30rem 22rem at 95% 90%, #082254, transparent 55%)',
              opacity: 0.1,
            }}
          />

          <div className="relative mx-auto w-full max-w-5xl px-4 py-16 sm:py-24">
            <p className="text-label-caps text-muted-foreground">{t('badge')}</p>
            <h1 className="mt-3 max-w-2xl font-heading text-4xl leading-tight font-semibold tracking-tight text-balance sm:text-5xl">
              {t('heroTitle')}
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-muted-foreground">
              {t('heroBody')}
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {/* 44px floor by hand: this page sits outside the auth layout,
                  so data-auth-surface does not raise these for us. */}
              <Link
                href="/register"
                className={cn(buttonVariants({ size: 'lg' }), 'min-h-11 px-6')}
              >
                {t('register')}
              </Link>
              <Link
                href="/login"
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'min-h-11 px-6')}
              >
                {t('signIn')}
              </Link>
            </div>
          </div>
        </section>

        {/* ── Features ──────────────────────────────────────────────────── */}
        <section className="mx-auto w-full max-w-5xl px-4 pb-20">
          <h2 className="text-label-caps text-muted-foreground">{t('featuresHeading')}</h2>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <div key={title} className="surface-1 rounded-xl p-6">
                <span className="grid size-10 place-items-center rounded-md bg-primary/10 text-primary">
                  <Icon aria-hidden className="size-5" />
                </span>
                <h3 className="mt-4 font-heading text-lg font-semibold tracking-tight">
                  {t(title)}
                </h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{t(body)}</p>
              </div>
            ))}
          </div>
        </section>
      </main>

      {/* ── Footer ─────────────────────────────────────────────────────── */}
      <footer className="border-t">
        <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-8 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} Bookends Hospitality. {t('footerRights')}
          </p>
          <nav aria-label={t('langLine')} className="flex items-center gap-1">
            <span className="mr-1">{t('langLine')}</span>
            {LOCALES.filter((l) => l.code !== locale).map((l) => (
              <Link
                key={l.code}
                href="/"
                locale={l.code}
                className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'min-h-11')}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  )
}
