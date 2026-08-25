import en from '../../../messages/en.json'
import hi from '../../../messages/hi.json'
import gu from '../../../messages/gu.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The renderer migration 0007 pointed at and nobody wrote.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ email_outbox.template has always been documented as "template id in       ║
 * ║ src/lib/notifications/templates" — a directory that did not exist. The    ║
 * ║ queue accumulated 1,369 rows naming renderers that were never built.      ║
 * ║                                                                           ║
 * ║ SUBJECT IS NOT COMPOSED HERE. It is written at enqueue time, in SQL,      ║
 * ║ already carrying the exam title (0014_exams.sql:741). Recomposing it      ║
 * ║ would mean two sources for one string that must agree, so this renders    ║
 * ║ the BODY only and takes the subject from the row.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY THE BUNDLES ARE IMPORTED RATHER THAN READ THROUGH next-intl:
 * getTranslations() resolves a locale from the REQUEST. A drain job has no
 * meaningful request locale — the language is a property of the recipient
 * (profiles.preferred_locale), and one run sends to people in three different
 * languages. Importing the bundles and merging over English here is the same
 * fallback src/lib/i18n/request.ts performs, made explicit and testable.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const BUNDLES = { en, hi, gu } as const
export type EmailLocale = keyof typeof BUNDLES

type EmailCopy = (typeof en)['emails']

/** Falls back to English per FIELD, not per bundle — a partial translation still works. */
function copyFor(locale: string): EmailCopy {
  const bundle = (BUNDLES as Record<string, { emails?: unknown }>)[locale]
  const theirs = (bundle?.emails ?? {}) as Partial<EmailCopy>
  return {
    ...en.emails,
    ...theirs,
    examAssigned: { ...en.emails.examAssigned, ...(theirs.examAssigned ?? {}) },
    registrationApproved: {
      ...en.emails.registrationApproved,
      ...(theirs.registrationApproved ?? {}),
    },
    resultPublished: { ...en.emails.resultPublished, ...(theirs.resultPublished ?? {}) },
  }
}

/** Minimal, deliberate: these strings come from our own bundles and database. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    key in values ? values[key] : whole,
  )
}

export interface RenderInput {
  /** email_outbox.template */
  template: string
  /** email_outbox.subject — already localised at enqueue time is NOT assumed; see below. */
  subject: string
  /** email_outbox.payload */
  payload: Record<string, unknown>
  /** profiles.preferred_locale, or 'en'. */
  locale: string
  /** Recipient's display name, if known. */
  name?: string | null
  /** Absolute app URL, when configured. A link is omitted rather than broken. */
  appUrl?: string | null
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

/**
 * The one thing this must never do is throw.
 *
 * A renderer that throws on an unrecognised template id would wedge the queue
 * behind the first row naming a template somebody adds in SQL before adding it
 * here — and the row would burn all five attempts on a bug, not a transient
 * failure. An unknown id degrades to the subject as its own body instead.
 */
export function renderEmail(input: RenderInput): RenderedEmail {
  const c = copyFor(input.locale)
  const name = (input.name ?? '').trim()
  const greeting = name ? fill(c.greeting, { name }) : ''

  const title = String(
    input.payload.exam_title ?? input.payload.title ?? '',
  ).trim()

  let heading: string
  let body: string
  let cta: string | null = null
  let path: string | null = null

  switch (input.template) {
    case 'exam-assigned':
      heading = c.examAssigned.heading
      // The subject carries the title when the payload does not — exam-assigned
      // rows store only a dedupe key (0014_exams.sql:743).
      body = fill(c.examAssigned.body, { title: title || subjectTail(input.subject) })
      cta = c.examAssigned.cta
      path = `/${input.locale}/my-exams`
      break

    case 'registration-approved':
      // Queued by approve_registration() (0086). The one email in this system
      // that goes to somebody who has never signed in, so it links to login
      // rather than anywhere behind the gate.
      heading = c.registrationApproved.heading
      body = c.registrationApproved.body
      cta = c.registrationApproved.cta
      path = `/${input.locale}/login`
      break

    case 'result-published':
      heading = c.resultPublished.heading
      body = fill(c.resultPublished.body, { title: title || subjectTail(input.subject) })
      cta = c.resultPublished.cta
      path = typeof input.payload.attempt_id === 'string'
        ? `/${input.locale}/results/${input.payload.attempt_id}`
        : `/${input.locale}/results`
      break

    default:
      // Unknown id: say the one true thing we have rather than nothing.
      heading = input.subject
      body = input.subject
      break
  }

  const href = input.appUrl && path ? `${input.appUrl.replace(/\/$/, '')}${path}` : null

  const html = [
    '<div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;line-height:1.6;color:#1a1a1a;max-width:520px">',
    `<h1 style="font-size:20px;margin:0 0 16px">${escapeHtml(heading)}</h1>`,
    greeting ? `<p style="margin:0 0 12px">${escapeHtml(greeting)}</p>` : '',
    `<p style="margin:0 0 20px">${escapeHtml(body)}</p>`,
    href && cta
      ? `<p style="margin:0 0 24px"><a href="${escapeHtml(href)}" style="background:#1a1a1a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;display:inline-block">${escapeHtml(cta)}</a></p>`
      : '',
    `<p style="margin:0;font-size:13px;color:#6b6b6b">${escapeHtml(c.footer)}</p>`,
    '</div>',
  ]
    .filter(Boolean)
    .join('')

  const text = [greeting, body, href ? `${cta}: ${href}` : '', c.footer]
    .filter(Boolean)
    .join('\n\n')

  return { subject: input.subject, html, text }
}

/** "You have a new exam: Knife skills" → "Knife skills". Never returns empty. */
function subjectTail(subject: string): string {
  const idx = subject.indexOf(':')
  const tail = idx >= 0 ? subject.slice(idx + 1).trim() : ''
  return tail || subject
}
