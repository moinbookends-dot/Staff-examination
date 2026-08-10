'use client'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One-tap sign-in for the sample accounts, while developing.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS PUTS PASSWORDS ON THE LOGIN SCREEN. IT MUST NEVER REACH PRODUCTION.  ║
 * ║                                                                           ║
 * ║ IT TAKES THEM AS PROPS AND IMPORTS NOTHING. That is the whole safeguard,  ║
 * ║ and the first version got it wrong: it did `import devAccounts from       ║
 * ║ '@/lib/dev-accounts.json'` behind a NODE_ENV check in the page, and the   ║
 * ║ comment here claimed a production build would drop it.                    ║
 * ║                                                                           ║
 * ║ It did not. A production build was searched for the password and FOUND    ║
 * ║ it, in .next/static and .next/server alike — a static import is part of   ║
 * ║ the module graph whatever a runtime condition later says about rendering. ║
 * ║                                                                           ║
 * ║ Now the credentials live in dev-accounts.json at the project root, OUTSIDE ║
 * ║ src/, and are read with fs by the page only when NODE_ENV is not          ║
 * ║ production. Nothing imports them, so nothing can bundle them.             ║
 * ║                                                                           ║
 * ║ The accounts exist only after `npm run db:sample` and are deleted by      ║
 * ║ `npm run db:sample -- --clean`. None is a real person's account.          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The form is uncontrolled — it posts to a Server Action rather than holding
 * React state — so filling it is a DOM assignment rather than a setState. That
 * is why this reads the two inputs by id instead of lifting their state up: a
 * dev convenience should not reshape the real form.
 */
export interface DevAccount {
  email: string
  label: string
  can: string
}

export function DevQuickLogin({ password, accounts }: { password: string; accounts: DevAccount[] }) {
  const fill = (email: string) => {
    const emailInput = document.getElementById('email') as HTMLInputElement | null
    const passwordInput = document.getElementById('password') as HTMLInputElement | null
    if (!emailInput || !passwordInput) return

    emailInput.value = email
    passwordInput.value = password

    // Nudge React and any validation listening for real typing, so the fields
    // do not look empty to anything watching them.
    for (const input of [emailInput, passwordInput]) {
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    passwordInput.focus()
  }

  return (
    <div className="mt-6 rounded-xl border border-dashed bg-muted/40 p-4">
      <p className="text-label-caps text-muted-foreground">
        Development sign-in · not shown in production
      </p>
      <p className="mt-1 text-body-sm text-muted-foreground">
        Tap a role to fill the form. Password for all:{' '}
        <code className="rounded bg-muted px-1 py-0.5">{password}</code>
      </p>

      <ul className="mt-3 space-y-1.5">
        {accounts.map((account) => (
          <li key={account.email}>
            <button
              type="button"
              onClick={() => fill(account.email)}
              className="flex w-full flex-col items-start gap-0.5 rounded-lg border bg-card px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
            >
              <span className="flex w-full flex-wrap items-baseline justify-between gap-2">
                <span className="text-body-sm font-medium">{account.label}</span>
                <span className="text-label-caps text-muted-foreground">{account.email}</span>
              </span>
              <span className="text-body-sm text-muted-foreground">{account.can}</span>
            </button>
          </li>
        ))}
      </ul>

      <p className="mt-3 text-body-sm text-muted-foreground">
        These exist only after <code>npm run db:sample</code>.
      </p>
    </div>
  )
}
