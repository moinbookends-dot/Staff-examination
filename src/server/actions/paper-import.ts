'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAppClaims } from '@/lib/auth/claims'
import { can } from '@/lib/auth/can'
import { canEditQuestions, canOpenQuestionBank } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { PAPER_IMPORT_BATCH_SIZE } from '@/lib/bank/paper/commit'
import type { CommitRow, CommitText } from '@/lib/bank/import/commit'
import type { BankFact } from '@/lib/bank/paper/types'
import {
  BANK_LOCALES,
  DIFFICULTIES,
  OPTION_KEYS,
  QUESTION_TYPES,
  type BankLocale,
  type OptionKey,
  type QuestionStatus,
} from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The server half of the paper importer.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BROWSER SENDS ONE LANGUAGE. THIS FILE SENDS ALL OF THEM. THAT SPLIT   ║
 * ║ IS THE WHOLE DESIGN, AND IT EXISTS BECAUSE OF DATA THAT WAS ACTUALLY LOST.║
 * ║                                                                           ║
 * ║ bank_import_commit() ends its text loop with                              ║
 * ║                                                                           ║
 * ║   delete from bank_question_texts                                         ║
 * ║    where question_id = v_qid and not (locale = any (v_locales))           ║
 * ║                                                                           ║
 * ║ deliberately, so a re-import can RETRACT a bad translation. The corollary ║
 * ║ is that any language absent from the payload is DELETED.                  ║
 * ║                                                                           ║
 * ║ An earlier version of the Easy importer re-sent only English and the      ║
 * ║ locale it was adding. Importing Gujarati therefore deleted all 1,023      ║
 * ║ Hindi rows that had been imported an hour before. The run reported        ║
 * ║ "1023 updated" and exited successfully.                                   ║
 * ║                                                                           ║
 * ║ So the merge happens HERE, where the other languages can be read back     ║
 * ║ from the bank, and the wire shape the browser uses cannot express them    ║
 * ║ at all. It is a structural fix rather than a rule somebody must remember. ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AND IT IS WHY THE FILE IS NOT UPLOADED.                                   │
 * │                                                                           │
 * │ A Server Action body is capped at 1 MB. The Hindi Hard paper is 1.0 MB    │
 * │ and its answer key 586 KB, so posting either one would fail as a request  │
 * │ error on exactly the dataset this feature exists for. The document is     │
 * │ parsed in the browser; only the reviewed rows cross the wire, in batches. │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nothing here trusts the browser. The report it produced is a convenience;
 * every value below is either re-validated by a schema or re-read from the
 * bank, and RLS authorises every statement regardless of both.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const DENIED = 'Questions are imported by Editors only.'

export type PaperTargetsResult =
  | { ok: true; facts: BankFact[] }
  | { ok: false; message: string }

export type PaperCommitResult =
  | { ok: true; inserted: number; updated: number }
  | { ok: false; message: string; technical?: string }

// ─────────────────────────────────────────────────────────────────────────────
// Shared guard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The same three predicates the subtree layout, the nav tab and commitImport()
 * all use, evaluated together so no caller can satisfy two of them and skip the
 * third.
 *
 * `bank.import` is checked as well as `bank.write` because they are separate
 * grants: the tab is offered on bank.import, and a screen that offers an action
 * the server then refuses is a bug report waiting to be filed.
 */
async function requireImporter() {
  const claims = await getAppClaims()

  if (
    !canOpenQuestionBank(claims) ||
    !canEditQuestions(claims) ||
    !can(claims, 'bank.import') ||
    !claims.company_id
  ) {
    return { ok: false as const, message: DENIED }
  }
  return { ok: true as const, claims }
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolve — what does the bank already hold for the ids in this document?
// ─────────────────────────────────────────────────────────────────────────────

const externalIdList = z.array(z.string().trim().min(1).max(100)).min(1).max(5000)

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CHUNKED, BECAUSE PostgREST FILTERS TRAVEL IN THE URL.                     │
 * │                                                                           │
 * │ `.in('external_id', ids)` becomes `?external_id=in.(a,b,c,…)`. At 1,030   │
 * │ ids of ~15 characters that is a 16 KB query string, which is past what    │
 * │ proxies and the PostgREST server accept — and the failure arrives as a    │
 * │ bare 414, not as anything a person could act on.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const LOOKUP_CHUNK = 200

function chunk<T>(values: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size))
  return out
}

/**
 * The bank's own record for every id a document named.
 *
 * This is what turns a parsed document into a report that can say "1,030
 * existing, 0 new" BEFORE anything is written — and it is what every
 * answer-letter check is made against. A request carrying a thousand ids is
 * tiny; the response is not, and a response has no Server Action size cap.
 */
export async function resolvePaperTargets(
  brandId: unknown,
  externalIds: unknown,
): Promise<PaperTargetsResult> {
  const guard = await requireImporter()
  if (!guard.ok) return guard

  const brand = dbId().safeParse(brandId)
  if (!brand.success) return { ok: false, message: 'Choose a brand to import into.' }

  const ids = externalIdList.safeParse(externalIds)
  if (!ids.success) {
    return { ok: false, message: 'This document names no question ids that could be looked up.' }
  }

  const supabase = await createClient()
  const unique = [...new Set(ids.data)]

  // Topic slugs, so a report can show the topic a question already has rather
  // than the translated heading the document printed.
  const { data: topicRows } = await supabase
    .from('question_topics')
    .select('id, slug')
    .is('deleted_at', null)
  const topicSlugs = new Map((topicRows ?? []).map((topic) => [topic.id, topic.slug]))

  const questions: {
    id: string
    external_id: string
    qtype: (typeof QUESTION_TYPES)[number]
    difficulty: (typeof DIFFICULTIES)[number]
    status: QuestionStatus
    correct_option: string | null
    topic_id: string | null
  }[] = []

  for (const slice of chunk(unique, LOOKUP_CHUNK)) {
    const { data, error } = await supabase
      .from('bank_questions')
      .select('id, external_id, qtype, difficulty, status, correct_option, topic_id')
      .eq('brand_id', brand.data)
      .is('deleted_at', null)
      .in('external_id', slice)

    if (error) {
      return { ok: false, message: 'The bank could not be read to check these questions.' }
    }
    for (const row of data ?? []) {
      if (row.external_id) questions.push({ ...row, external_id: row.external_id })
    }
  }

  /*
   * Which languages each question already has. Only the locale column is read:
   * the report needs to say "this replaces the Hindi already there", and
   * pulling the text itself would move megabytes to a browser that has no use
   * for it. The merge reads the full text server-side, in commitPaperImport.
   */
  const locales = new Map<string, BankLocale[]>()
  for (const slice of chunk(
    questions.map((question) => question.id),
    LOOKUP_CHUNK,
  )) {
    const { data } = await supabase
      .from('bank_question_texts')
      .select('question_id, locale')
      .in('question_id', slice)

    for (const row of data ?? []) {
      const list = locales.get(row.question_id) ?? []
      if ((BANK_LOCALES as readonly string[]).includes(row.locale)) {
        list.push(row.locale as BankLocale)
      }
      locales.set(row.question_id, list)
    }
  }

  return {
    ok: true,
    facts: questions.map((question) => ({
      externalId: question.external_id,
      qtype: question.qtype,
      difficulty: question.difficulty,
      status: question.status,
      correctOption: readOption(question.correct_option),
      topicSlug: question.topic_id ? (topicSlugs.get(question.topic_id) ?? null) : null,
      locales: (locales.get(question.id) ?? []).sort(),
    })),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit
// ─────────────────────────────────────────────────────────────────────────────

const nullableText = z.string().max(4000).nullable()

/**
 * The wire row, re-stated as a schema rather than trusted from the client.
 *
 * Mirrors PaperCommitRow in src/lib/bank/paper/commit.ts. A client can post
 * anything at all to a Server Action, so "the browser already checked it" is
 * worth exactly nothing here.
 */
const paperRow = z.object({
  externalId: z.string().trim().min(1).max(100),
  action: z.enum(['update', 'create']),
  question: z.string().trim().min(1).max(2000),
  optionA: nullableText,
  optionB: nullableText,
  optionC: nullableText,
  optionD: nullableText,
  answerText: nullableText,
  explanation: nullableText,
  difficulty: z.enum(DIFFICULTIES),
  qtype: z.enum(QUESTION_TYPES),
  topicSlug: z.string().max(120).nullable(),
  correctOption: z.enum(OPTION_KEYS).nullable(),
})

const commitInput = z.object({
  brandId: dbId(),
  locale: z.enum(BANK_LOCALES),
  rows: z.array(paperRow).min(1).max(PAPER_IMPORT_BATCH_SIZE),
})

export async function commitPaperImport(input: unknown): Promise<PaperCommitResult> {
  const guard = await requireImporter()
  if (!guard.ok) return guard

  const parsed = commitInput.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      message: issue
        ? `A question in this batch is not shaped correctly (${issue.path.join('.') || 'root'}).`
        : 'This batch could not be read.',
      technical: JSON.stringify(parsed.error.issues.slice(0, 3)),
    }
  }

  const { brandId, locale, rows } = parsed.data

  const duplicate = firstDuplicate(rows.map((row) => row.externalId))
  if (duplicate) {
    return {
      ok: false,
      message: `This batch contains "${duplicate}" twice. Two questions cannot share one id — the second would silently overwrite the first.`,
    }
  }

  const supabase = await createClient()
  const built = await buildCommitRows(supabase, brandId, locale, rows)
  if (!built.ok) return built

  const { data, error } = await supabase.rpc('bank_import_commit', {
    p_brand_id: brandId,
    p_rows: built.rows,
  })

  if (error) return explain(error)

  /*
   * gen-types.mjs emits `Returns: unknown` for every function, so the result is
   * validated rather than asserted. An unreadable result is reported as a
   * failure: the transaction may well have committed, and claiming a specific
   * number we did not actually read would be worse than saying it went wrong.
   */
  const result = z.object({ inserted: z.number().int(), updated: z.number().int() }).safeParse(data)
  if (!result.success) {
    return { ok: false, message: 'The import ran but its result could not be read.' }
  }

  revalidatePath('/questions')
  revalidatePath('/dashboard')
  revalidatePath('/papers/generate')

  return { ok: true, inserted: result.data.inserted, updated: result.data.updated }
}

/**
 * One batch of wire rows, expanded into the rows bank_import_commit() reads.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY LOCALE THE BANK ALREADY HOLDS IS CARRIED FORWARD, VERBATIM.         ║
 * ║ Omitting one deletes it. See the box at the top of this file.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * And every field except the text comes from the BANK for a question that
 * exists — difficulty, type, status, topic and the correct option. That is a
 * correctness rule first: a translated document has no difficulty and its topic
 * heading is translated. It is a security property second, and a real one — it
 * means no client can relevel, retopic or re-answer a question by editing a
 * payload, whatever the screen let them type.
 */
async function buildCommitRows(
  supabase: Awaited<ReturnType<typeof createClient>>,
  brandId: string,
  locale: BankLocale,
  rows: z.infer<typeof commitInput>['rows'],
): Promise<{ ok: true; rows: CommitRow[] } | { ok: false; message: string; technical?: string }> {
  const ids = rows.map((row) => row.externalId)

  const { data: existingRows, error } = await supabase
    .from('bank_questions')
    .select('id, external_id, qtype, difficulty, status, correct_option, topic_id')
    .eq('brand_id', brandId)
    .is('deleted_at', null)
    .in('external_id', ids)

  if (error) {
    return { ok: false, message: 'The bank could not be read to check these questions.' }
  }

  const existing = new Map(
    (existingRows ?? [])
      .filter((row): row is typeof row & { external_id: string } => Boolean(row.external_id))
      .map((row) => [row.external_id, row]),
  )

  const { data: topicRows } = await supabase
    .from('question_topics')
    .select('id, slug')
    .is('deleted_at', null)
  const slugById = new Map((topicRows ?? []).map((topic) => [topic.id, topic.slug]))
  const knownSlugs = new Set((topicRows ?? []).map((topic) => topic.slug))

  // ── Every language already stored, for the questions in this batch ────────
  const prior = new Map<string, CommitText[]>()
  const existingIds = [...existing.values()].map((row) => row.id)

  if (existingIds.length > 0) {
    const { data: textRows, error: textError } = await supabase
      .from('bank_question_texts')
      .select(
        'question_id, locale, question, option_a, option_b, option_c, option_d, answer_text, explanation',
      )
      .in('question_id', existingIds)

    if (textError) {
      return {
        ok: false,
        message:
          'The existing translations could not be read, so this import was stopped before it could delete them.',
      }
    }

    for (const row of textRows ?? []) {
      const list = prior.get(row.question_id) ?? []
      list.push({
        locale: row.locale,
        question: row.question,
        optionA: row.option_a,
        optionB: row.option_b,
        optionC: row.option_c,
        optionD: row.option_d,
        answerText: row.answer_text,
        explanation: row.explanation,
      })
      prior.set(row.question_id, list)
    }
  }

  const built: CommitRow[] = []

  for (const row of rows) {
    const bank = existing.get(row.externalId)

    if (!bank) {
      /*
       * Creating a question needs English, because bank_question_texts_
       * completeness and importQuestionSchema both require it and a question
       * with no English text cannot be made active or matched for a re-import.
       * The browser reports this per id before the button is enabled; refusing
       * it again here is what makes the rule true rather than merely displayed.
       */
      if (locale !== 'en') {
        return {
          ok: false,
          message: `"${row.externalId}" is not in the bank for this brand. A question cannot be created from a ${localeName(locale)} document — it has no English text to create one from.`,
        }
      }
      if (!row.topicSlug || !knownSlugs.has(row.topicSlug)) {
        return {
          ok: false,
          message: `"${row.externalId}" names the topic "${row.topicSlug ?? '(none)'}", which does not exist. Add it in Topic Management first, or map it to one that does.`,
        }
      }

      built.push({
        externalId: row.externalId,
        difficulty: row.difficulty,
        qtype: row.qtype,
        // Only English is being supplied, and exam_settings.required_locales is
        // the rule for what "complete" means. Anything beyond English missing
        // means the question lands as a draft rather than being refused by the
        // completeness trigger mid-transaction.
        status: 'active',
        topicSlug: row.topicSlug,
        correctOption: row.qtype === 'mcq' ? row.correctOption : null,
        referenceTitle: null,
        referencePage: null,
        texts: [textFor(locale, row.qtype, row)],
      })
      continue
    }

    const carried = (prior.get(bank.id) ?? []).filter((text) => text.locale !== locale)

    built.push({
      externalId: row.externalId,
      // ── From the bank, never from the payload ──────────────────────────────
      difficulty: bank.difficulty,
      qtype: bank.qtype,
      status: bank.status,
      topicSlug: bank.topic_id ? (slugById.get(bank.topic_id) ?? null) : null,
      correctOption: bank.qtype === 'mcq' ? bank.correct_option : null,
      referenceTitle: null,
      referencePage: null,
      texts: [...carried, textFor(locale, bank.qtype, row)],
    })
  }

  return { ok: true, rows: built }
}

/**
 * The new language's text.
 *
 * `qtype` is passed in rather than read off the row because for a question that
 * already exists it is the BANK's type that decides the shape — a document
 * presenting a short answer as an MCQ must not be able to write four options
 * onto a question the bank knows has none.
 */
function textFor(
  locale: BankLocale,
  qtype: 'mcq' | 'short_answer',
  row: z.infer<typeof paperRow>,
): CommitText {
  return {
    locale,
    question: row.question,
    // An MCQ has options and no answer; a short answer the reverse. Spelled out
    // as null rather than left absent so the SQL never has to tell "absent"
    // from "empty", which in JSON it cannot do reliably.
    optionA: qtype === 'mcq' ? emptyToNull(row.optionA) : null,
    optionB: qtype === 'mcq' ? emptyToNull(row.optionB) : null,
    optionC: qtype === 'mcq' ? emptyToNull(row.optionC) : null,
    optionD: qtype === 'mcq' ? emptyToNull(row.optionD) : null,
    answerText: qtype === 'short_answer' ? emptyToNull(row.answerText) : null,
    explanation: emptyToNull(row.explanation),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Import history
// ─────────────────────────────────────────────────────────────────────────────

const runInput = z.object({
  brandId: dbId(),
  kind: z.enum(['json', 'paper']),
  locale: z.enum(BANK_LOCALES).nullable(),
  filename: z.string().trim().min(1).max(300),
  answerKeyFilename: z.string().trim().min(1).max(300).nullable(),
  detected: z.number().int().min(0),
  created: z.number().int().min(0),
  updated: z.number().int().min(0),
  skipped: z.number().int().min(0),
  rejected: z.number().int().min(0),
  warnings: z.number().int().min(0),
  status: z.enum(['completed', 'partial', 'failed']),
  message: z.string().max(2000).nullable(),
})

/**
 * Record that an import happened.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A FAILURE TO RECORD IS NEVER A FAILURE TO IMPORT.                         │
 * │                                                                           │
 * │ The questions are already written by the time this runs. Reporting "the   │
 * │ import failed" because the history row would not insert would send        │
 * │ somebody to re-run a 1,030-question import that had in fact succeeded.    │
 * │ So this returns whether it recorded, and the caller treats that as        │
 * │ information rather than as an outcome.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function recordImportRun(input: unknown): Promise<{ recorded: boolean }> {
  const guard = await requireImporter()
  if (!guard.ok) return { recorded: false }

  const parsed = runInput.safeParse(input)
  if (!parsed.success) return { recorded: false }

  const supabase = await createClient()
  const { error } = await supabase.from('bank_import_runs').insert({
    company_id: guard.claims.company_id!,
    brand_id: parsed.data.brandId,
    actor_id: guard.claims.userId,
    kind: parsed.data.kind,
    locale: parsed.data.locale,
    filename: parsed.data.filename,
    answer_key_filename: parsed.data.answerKeyFilename,
    detected: parsed.data.detected,
    created: parsed.data.created,
    updated: parsed.data.updated,
    skipped: parsed.data.skipped,
    rejected: parsed.data.rejected,
    warnings: parsed.data.warnings,
    status: parsed.data.status,
    message: parsed.data.message,
  })

  if (!error) revalidatePath('/questions/import')
  return { recorded: !error }
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A database error, as a sentence somebody holding a 1,030-question document
 * can act on.
 *
 * The batch rolled back whole, so every message says what to fix rather than
 * what was saved. The raw error is carried separately and shown only behind
 * "Technical details" — "constraint violation 23505" is not a sentence.
 */
function explain(error: { code?: string; message?: string }): PaperCommitResult {
  const technical = [error.code, error.message].filter(Boolean).join(' — ') || undefined

  switch (error.code) {
    case '23505':
      return {
        ok: false,
        technical,
        message:
          'A question in this batch has the same English text as a different question at the same level, and the bank refuses two that read identically. This happens when a revision moves a sentence from one question to another. Nothing in this batch was written; earlier batches were.',
      }
    case '23503':
      return {
        ok: false,
        technical,
        message: error.message?.includes('topic')
          ? 'This batch names a topic that does not exist. Add it in Topic Management first.'
          : 'This batch refers to something that does not exist in this company.',
      }
    case '23514':
      return {
        ok: false,
        technical,
        message:
          'A question in this batch broke one of the bank’s own limits — usually a text that is too long, or a required translation that is missing. Nothing was written.',
      }
    case '42501':
      return { ok: false, technical, message: DENIED }
    default:
      return {
        ok: false,
        technical,
        message: error.message
          ? `The import was rejected and nothing in this batch was written. ${error.message}`
          : 'The import was rejected and nothing in this batch was written.',
      }
  }
}

function firstDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) return value
    seen.add(value)
  }
  return null
}

function emptyToNull(value: string | null): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function readOption(value: string | null): OptionKey | null {
  return value && (OPTION_KEYS as readonly string[]).includes(value) ? (value as OptionKey) : null
}

function localeName(locale: BankLocale): string {
  return locale === 'hi' ? 'Hindi' : locale === 'gu' ? 'Gujarati' : 'English'
}
