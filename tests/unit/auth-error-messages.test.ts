import { describe, it, expect } from 'vitest'
import en from '../../messages/en.json'
import hi from '../../messages/hi.json'
import gu from '../../messages/gu.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The messages a registrant sees when something goes wrong, in their language.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THESE ARE THE STRINGS SOMEBODY READS AT THE MOMENT THEY ARE STUCK, so a  ║
 * ║ silent fall back to English is worse here than on any admin screen — the ║
 * ║ person is not signed in, has no other route, and cannot ask the product  ║
 * ║ what happened.                                                           ║
 * ║                                                                          ║
 * ║ next-intl deep-merges every bundle over English, so a MISSING key never  ║
 * ║ throws and never shows a key name — it silently renders English to a     ║
 * ║ Gujarati reader and no test that only checks "the key resolves" would    ║
 * ║ notice. Hence the second assertion: the value must DIFFER from English.  ║
 * ║                                                                          ║
 * ║ Deliberately narrow. The rest of the auth namespace still falls back by  ║
 * ║ design; this pins the errors on the registration and verification path,  ║
 * ║ which is where a stuck person actually lands.                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const KEYS = [
  'emailRateLimited',
  'emailSendFailed',
  'registrationFailed',
  'checkTheForm',
  'codeNotAccepted',
  'enterTheCode',
] as const

const bundles = { hi, gu } as Record<string, { auth: { errors: Record<string, string> } }>

describe('auth error messages', () => {
  it('English defines every key the actions ask for', () => {
    for (const key of KEYS) {
      expect(en.auth.errors[key as keyof typeof en.auth.errors]).toBeTypeOf('string')
    }
  })

  for (const locale of ['hi', 'gu']) {
    describe(locale, () => {
      it('defines every key natively', () => {
        for (const key of KEYS) {
          expect(bundles[locale].auth.errors[key]).toBeTypeOf('string')
        }
      })

      it('is actually translated, not the English text copied across', () => {
        for (const key of KEYS) {
          expect(bundles[locale].auth.errors[key]).not.toBe(
            en.auth.errors[key as keyof typeof en.auth.errors],
          )
        }
      })

      it('is not blank', () => {
        for (const key of KEYS) {
          expect(bundles[locale].auth.errors[key].trim().length).toBeGreaterThan(0)
        }
      })
    })
  }

  it('does not promise a wait it cannot keep', () => {
    /*
     * The bug this replaces: "Wait a few minutes and try again." The built-in
     * SMTP quota resets HOURLY, so five minutes later the form fails again and
     * the person concludes verification is broken. If the English copy ever
     * goes back to promising minutes, this fails.
     */
    expect(en.auth.errors.emailRateLimited).not.toMatch(/few minutes/i)
    expect(en.auth.errors.emailRateLimited).toMatch(/hour/i)
  })

  it('does not blame the registrant for a failure on the server', () => {
    /*
     * A 500 "Error sending confirmation email" used to fall through to
     * "Check your details and try again", which sends someone to retype a
     * form that was never wrong. The copy must not tell them to check
     * anything they typed.
     */
    expect(en.auth.errors.emailSendFailed).not.toMatch(/check your details/i)
    expect(en.auth.errors.emailSendFailed).toMatch(/our side|administrator/i)
  })

  it('never leaks infrastructure detail to a candidate', () => {
    // SMTP hosts, ports and credentials are not something a kitchen porter
    // can act on, and naming them on a public form is needless exposure.
    for (const bundle of [en, hi, gu]) {
      expect(JSON.stringify(bundle.auth.errors)).not.toMatch(/smtp|port|credential|resend|sendgrid/i)
    }
  })

  it('never tells someone holding an 8-digit code to enter 6 digits', () => {
    // GoTrue mints 8-digit codes on this project; the schema accepts 4–12.
    for (const bundle of [en, hi, gu]) {
      expect(JSON.stringify(bundle.auth.errors)).not.toMatch(/6-digit|6 digit/i)
    }
  })
})
