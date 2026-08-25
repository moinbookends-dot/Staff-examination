import { describe, it, expect } from 'vitest'
import { renderEmail } from '@/lib/notifications/templates'
import en from '../../messages/en.json'
import hi from '../../messages/hi.json'
import gu from '../../messages/gu.json'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The email bodies, in three languages.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE TEMPLATE IDS ARE WRITTEN IN SQL AND RENDERED IN TYPESCRIPT, so        ║
 * ║ nothing but a test holds the two ends together. These two ids are the     ║
 * ║ ones the database actually enqueues:                                      ║
 * ║                                                                           ║
 * ║   exam-assigned     0014_exams.sql:741                                    ║
 * ║   result-published  0029_results_and_release_notice.sql:81                ║
 * ║                                                                           ║
 * ║ An id added in SQL without a renderer here must NOT throw — it would put  ║
 * ║ a row into a retry loop against a bug rather than a transient fault, and  ║
 * ║ burn all five attempts doing it. Degrading to the stored subject is the   ║
 * ║ deliberate behaviour, and it is asserted below.                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const APP = 'https://bookends-exam.onrender.com'

describe('the templates the database enqueues', () => {
  it('renders exam-assigned with the exam name taken from the subject', () => {
    // exam-assigned stores only a dedupe key, so the title lives in the subject.
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'You have a new exam: Knife skills',
      payload: { dedupe_key: 'exam-assigned:e1:u1' },
      locale: 'en',
      name: 'Asha',
      appUrl: APP,
    })
    expect(out.subject).toBe('You have a new exam: Knife skills')
    expect(out.html).toContain('Knife skills')
    expect(out.html).toContain('Asha')
    expect(out.html).toContain(`${APP}/en/my-exams`)
  })

  it('renders result-published and links to the specific attempt', () => {
    const out = renderEmail({
      template: 'result-published',
      subject: 'Your result for Line check',
      payload: { attempt_id: 'att-9', exam_title: 'Line check' },
      locale: 'en',
      name: 'Asha',
      appUrl: APP,
    })
    expect(out.html).toContain('Line check')
    expect(out.html).toContain(`${APP}/en/results/att-9`)
  })

  it('falls back to the results list when the attempt id is missing', () => {
    const out = renderEmail({
      template: 'result-published',
      subject: 'Your result for Line check',
      payload: {},
      locale: 'en',
      appUrl: APP,
    })
    expect(out.html).toContain(`${APP}/en/results`)
  })
})

describe('the approval email', () => {
  it('renders and links to sign-in, not behind the gate', () => {
    // The only email that reaches somebody who has never signed in, so every
    // other destination would ask them to authenticate first.
    const out = renderEmail({
      template: 'registration-approved',
      subject: 'Your Bookends Learning account is ready',
      payload: { dedupe_key: 'registration-approved:u1' },
      locale: 'en',
      name: 'Asha',
      appUrl: APP,
    })
    expect(out.html).toContain(en.emails.registrationApproved.heading)
    expect(out.html).toContain(`${APP}/en/login`)
  })

  it('is translated in every language', () => {
    for (const [locale, bundle] of [['hi', hi], ['gu', gu]] as const) {
      const out = renderEmail({
        template: 'registration-approved',
        subject: 'x',
        payload: {},
        locale,
      })
      expect(out.html).toContain(bundle.emails.registrationApproved.heading)
      expect(bundle.emails.registrationApproved.heading).not.toBe(
        en.emails.registrationApproved.heading,
      )
    }
  })
})

describe('an unrecognised template', () => {
  it('renders rather than throwing', () => {
    expect(() =>
      renderEmail({
        template: 'something-added-in-sql-later',
        subject: 'A message for you',
        payload: {},
        locale: 'en',
      }),
    ).not.toThrow()
  })

  it('still says the one true thing it has — the subject', () => {
    const out = renderEmail({
      template: 'unknown',
      subject: 'A message for you',
      payload: {},
      locale: 'en',
    })
    expect(out.subject).toBe('A message for you')
    expect(out.html).toContain('A message for you')
  })
})

describe('the link', () => {
  it('is omitted entirely when no app URL is configured', () => {
    // Better no button than a button to nowhere.
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'You have a new exam: Prep',
      payload: {},
      locale: 'en',
      appUrl: null,
    })
    expect(out.html).not.toContain('<a href')
  })

  it('does not double a slash when the app URL has a trailing one', () => {
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'You have a new exam: Prep',
      payload: {},
      locale: 'en',
      appUrl: 'https://example.org/',
    })
    expect(out.html).toContain('https://example.org/en/my-exams')
    expect(out.html).not.toContain('example.org//')
  })

  it('points at the recipient’s own language', () => {
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'x: y',
      payload: {},
      locale: 'gu',
      appUrl: APP,
    })
    expect(out.html).toContain(`${APP}/gu/my-exams`)
  })
})

describe('language', () => {
  for (const locale of ['hi', 'gu'] as const) {
    it(`renders ${locale} in ${locale}, not English`, () => {
      const bundle = locale === 'hi' ? hi : gu
      const out = renderEmail({
        template: 'exam-assigned',
        subject: 'You have a new exam: Knife skills',
        payload: {},
        locale,
        appUrl: APP,
      })
      expect(out.html).toContain(bundle.emails.examAssigned.heading)
      expect(out.html).not.toContain(en.emails.examAssigned.heading)
    })
  }

  it('falls back to English for a locale that has no bundle', () => {
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'x: y',
      payload: {},
      locale: 'fr',
    })
    expect(out.html).toContain(en.emails.examAssigned.heading)
  })

  it('every locale translates the headings rather than copying English', () => {
    /*
     * Guards the deep-merge trap: a missing key silently renders English, and
     * a test that only checks "it resolves" would pass while a Gujarati reader
     * gets an English email.
     */
    for (const bundle of [hi, gu]) {
      expect(bundle.emails.examAssigned.heading).not.toBe(en.emails.examAssigned.heading)
      expect(bundle.emails.resultPublished.heading).not.toBe(en.emails.resultPublished.heading)
    }
  })
})

describe('safety', () => {
  it('escapes HTML in a title so a quiz name cannot inject markup', () => {
    const out = renderEmail({
      template: 'result-published',
      subject: 'Your result for x',
      payload: { exam_title: '<script>alert(1)</script>' },
      locale: 'en',
    })
    expect(out.html).not.toContain('<script>')
    expect(out.html).toContain('&lt;script&gt;')
  })

  it('produces a plain-text alternative alongside the HTML', () => {
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'You have a new exam: Knife skills',
      payload: {},
      locale: 'en',
      appUrl: APP,
    })
    expect(out.text).toContain('Knife skills')
    expect(out.text).not.toContain('<')
  })

  it('omits the greeting rather than addressing a blank name', () => {
    const out = renderEmail({
      template: 'exam-assigned',
      subject: 'x: y',
      payload: {},
      locale: 'en',
      name: '   ',
    })
    expect(out.html).not.toContain('Hello')
  })
})
