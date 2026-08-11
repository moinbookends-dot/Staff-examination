import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { getAppClaims } from '@/lib/auth/claims'
import { canSeeQuestionUuid } from '@/lib/auth/bank-access'
import { BANK_LOCALES, type BankLocale, type Difficulty } from '@/lib/bank/vocabulary'
import type {
  BankFormOptions,
  BankImportOptions,
  BankQuestionPage,
  BankQuestionRow,
  BankTopic,
} from '@/lib/bank/types'
import type { ExportRow } from '@/lib/bank/import/export'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Reads for the Question Bank screens.
 *
 * Separate from availability.ts, which serves the paper screens: these require
 * bank.read and those do not, and keeping the two files apart makes it obvious
 * which permission a given read sits behind.
 *
 * Every query uses the caller's client, so RLS is the authorisation. A caller
 * without bank.read gets empty results rather than an error — the screens gate
 * on canOpenQuestionBank so the two never disagree.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export async function loadTopics(): Promise<BankTopic[]> {
  const supabase = await createClient()

  const { data } = await supabase
    .from('question_topics')
    .select('id, name, slug, sort_order')
    .is('deleted_at', null)
    .order('sort_order')

  // questionCount is filled by loadTopicsWithUsage where it is needed; the
  // picker does not need it and counting on every form render would be a
  // second query for a number nobody reads.
  return (data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    sortOrder: t.sort_order,
    questionCount: 0,
  }))
}

/**
 * Archived topics, for the restore list.
 *
 * Readable through question_topics_read_deleted (0053), which is keyed on
 * bank.write — the same rule 0041 established for questions: whoever may
 * remove something may see what they removed.
 */
export async function loadArchivedTopics(): Promise<BankTopic[]> {
  const supabase = await createClient()

  const { data } = await supabase
    .from('question_topics')
    .select('id, name, slug, sort_order')
    .not('deleted_at', 'is', null)
    .order('name')

  return (data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    sortOrder: t.sort_order,
    questionCount: 0,
  }))
}

/** Topics with how many questions use each — for the management screen. */
export async function loadTopicsWithUsage(): Promise<BankTopic[]> {
  const supabase = await createClient()

  const [topics, questions] = await Promise.all([
    supabase
      .from('question_topics')
      .select('id, name, slug, sort_order')
      .is('deleted_at', null)
      .order('sort_order'),
    supabase.from('bank_questions').select('topic_id').is('deleted_at', null),
  ])

  const usage = new Map<string, number>()
  for (const q of questions.data ?? []) {
    if (q.topic_id) usage.set(q.topic_id, (usage.get(q.topic_id) ?? 0) + 1)
  }

  return (topics.data ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    slug: t.slug,
    sortOrder: t.sort_order,
    questionCount: usage.get(t.id) ?? 0,
  }))
}

/**
 * Everything the editor form needs besides the question itself.
 *
 * One call rather than four, because all four are needed together and
 * threading them separately through the page, the form and its pickers is four
 * chances to forget one.
 */
export async function loadFormOptions(): Promise<BankFormOptions> {
  const supabase = await createClient()
  const claims = await getAppClaims()

  /*
   * The reference-document picker went with the Guide.
   *
   * source_documents was dropped, and with it the only way a question could
   * cite a page in a cookbook. bank_questions.reference_document_id and
   * reference_page were dropped in the same migration, so there is nothing
   * left to populate a picker with.
   */
  const [brands, topics, settings] = await Promise.all([
    supabase.from('brands').select('id, name').is('deleted_at', null).order('name'),
    loadTopics(),
    supabase.from('exam_settings').select('required_locales, label_easy, label_medium, label_hard').maybeSingle(),
  ])

  const rawRequired = settings.data?.required_locales ?? ['en']
  const requiredLocales = rawRequired.filter((l): l is BankLocale =>
    (BANK_LOCALES as readonly string[]).includes(l),
  )

  const difficultyLabels: Record<Difficulty, string> = {
    easy: settings.data?.label_easy ?? 'Easy',
    medium: settings.data?.label_medium ?? 'Medium',
    hard: settings.data?.label_hard ?? 'Hard',
  }

  return {
    brands: (brands.data ?? []).map((b) => ({ id: b.id, name: b.name })),
    topics,
    // Server-decided. The id is absent from the payload for anybody else, and
    // a field the server never sent cannot be recovered in the browser.
    showsUuid: canSeeQuestionUuid(claims),
    requiredLocales: requiredLocales.length > 0 ? requiredLocales : ['en'],
    difficultyLabels,
  }
}

/**
 * Everything the import screen needs before a file is chosen.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE externalIds ARE SENT TO THE BROWSER, AND THAT IS THE POINT.           │
 * │                                                                           │
 * │ The dry run runs client-side (analyse.ts is pure, and a multi-megabyte    │
 * │ file cannot be posted to a Server Action — the body cap is 1 MB). To say  │
 * │ "1,200 new, 1,800 updated" BEFORE writing, it needs to know which ids are │
 * │ already in the bank.                                                      │
 * │                                                                           │
 * │ These are the CURATOR'S OWN identifiers, not database UUIDs — the thing   │
 * │ canSeeQuestionUuid() protects is deliberately not included. An id like    │
 * │ "easy-0001" discloses nothing that the file being imported does not       │
 * │ already contain, and only an Editor can reach this screen at all.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function loadImportOptions(): Promise<BankImportOptions> {
  const supabase = await createClient()
  const form = await loadFormOptions()

  const { data } = await supabase
    .from('bank_questions')
    .select('external_id')
    .not('external_id', 'is', null)

  return {
    brands: form.brands,
    topicSlugs: form.topics.map((t) => t.slug),
    requiredLocales: form.requiredLocales,
    difficultyLabels: form.difficultyLabels,
    existingExternalIds: (data ?? [])
      .map((row) => row.external_id)
      .filter((id): id is string => typeof id === 'string'),
  }
}

/**
 * One page of the Question Bank list.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ PAGINATED FROM THE START, BECAUSE THE TARGET IS 3,000 PER LEVEL.          │
 * │                                                                           │
 * │ An unbounded select would work perfectly on today's empty bank and become │
 * │ a 9,000-row transfer the week the dataset lands. `.range()` is the same    │
 * │ shape loadPaperHistory uses.                                              │
 * │                                                                           │
 * │ The count is requested with `{ count: 'exact' }` rather than derived from  │
 * │ the returned rows — the page needs the TOTAL to render pagination, and     │
 * │ rows.length is only ever the page size.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Deleted questions are excluded. RLS shows them only to a bank.delete holder,
 * and the recycle bin is a separate screen rather than a mode of this one.
 */
export async function loadQuestionPage(options: {
  page?: number
  pageSize?: number
} = {}): Promise<BankQuestionPage> {
  const supabase = await createClient()
  const claims = await getAppClaims()

  const pageSize = Math.min(Math.max(options.pageSize ?? 25, 1), 100)
  const page = Math.max(options.page ?? 1, 1)
  const from = (page - 1) * pageSize

  const { data, count } = await supabase
    .from('bank_questions')
    .select('id, brand_id, difficulty, qtype, status, topic_id, correct_option, created_at', {
      count: 'exact',
    })
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(from, from + pageSize - 1)

  const showsUuid = canSeeQuestionUuid(claims)
  const rows = data ?? []

  if (rows.length === 0) {
    return { rows: [], total: count ?? 0, page, pageSize, showsUuid }
  }

  // Separate queries rather than embeds — gen-types.mjs emits
  // `Relationships: []`, so an embedded select cannot be typed. Three queries
  // for a page of any size, not one per row.
  const [texts, topics, brands] = await Promise.all([
    supabase
      .from('bank_question_texts')
      .select('question_id, locale, question')
      .in('question_id', rows.map((r) => r.id)),
    supabase.from('question_topics').select('id, name'),
    supabase.from('brands').select('id, name'),
  ])

  const topicName = new Map((topics.data ?? []).map((t) => [t.id, t.name]))
  const brandName = new Map((brands.data ?? []).map((b) => [b.id, b.name]))

  const english = new Map<string, string>()
  const locales = new Map<string, BankLocale[]>()
  for (const row of texts.data ?? []) {
    if (row.locale === 'en') english.set(row.question_id, row.question)
    const list = locales.get(row.question_id) ?? []
    if ((BANK_LOCALES as readonly string[]).includes(row.locale)) {
      list.push(row.locale as BankLocale)
      locales.set(row.question_id, list)
    }
  }

  return {
    rows: rows.map((q) => ({
      // Present ONLY for a bank.read_uuid holder. Everybody else gets a field
      // that is absent from the payload rather than blanked in the browser.
      id: showsUuid ? q.id : undefined,
      rowKey: q.id,
      brandName: brandName.get(q.brand_id) ?? '',
      difficulty: q.difficulty,
      qtype: q.qtype,
      status: q.status,
      topicName: q.topic_id ? (topicName.get(q.topic_id) ?? null) : null,
      question: english.get(q.id) ?? '',
      completeLocales: locales.get(q.id) ?? [],
      createdAt: q.created_at,
    })),
    total: count ?? rows.length,
    page,
    pageSize,
    showsUuid,
  }
}

/**
 * Every question in one brand, in the shape the exporter transposes.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE BRAND, BECAUSE AN ALL-BRANDS FILE DOES NOT ROUND-TRIP.                │
 * │                                                                           │
 * │ 0054 stores a question that applies to every brand once PER BRAND, with   │
 * │ identical English text. Within a brand the unique index makes duplicates  │
 * │ impossible; across brands they are the normal case. Exporting the lot     │
 * │ would produce a file the importer reports as mostly duplicates, which is  │
 * │ a backup that cannot be restored.                                         │
 * │                                                                           │
 * │ Deleted questions are excluded — RLS shows them only under bank.delete    │
 * │ and a recycle bin is not part of the interchange format.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ TWO SILENT TRUNCATIONS LIVED HERE, AND BOTH PRODUCED A FILE THAT LOOKED   ║
 * ║ PERFECTLY VALID.                                                          ║
 * ║                                                                           ║
 * ║ 1. The questions query had no pagination. PostgREST caps a response at    ║
 * ║    1,000 rows by default, so a 3,000-question bank exported its first     ║
 * ║    third and said nothing.                                                ║
 * ║                                                                           ║
 * ║ 2. The texts query was one `.in('question_id', ids)` over EVERY id.       ║
 * ║    PostgREST puts that in the query string, so 403 questions built a      ║
 * ║    ~15KB URL, the request was refused, and `texts.data ?? []` turned the  ║
 * ║    refusal into an empty list. Measured: an export of 403 questions       ║
 * ║    returned 200, formatVersion 1, 403 question objects — and not one of   ║
 * ║    them had `en`, `hi` or `gu`. Re-importing that file rejects every      ║
 * ║    single row as missing-english.                                         ║
 * ║                                                                           ║
 * ║ Both are fixed by paging, and — the part that matters more — by REFUSING  ║
 * ║ rather than returning a partial bank. An export that silently drops       ║
 * ║ content is worse than one that fails, because it is the file somebody     ║
 * ║ hand-corrects and re-imports believing it is the whole bank.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

/** PostgREST's default ceiling. Pages are requested at exactly this size. */
const PAGE = 1000

/**
 * Ids per `.in()` request. 200 × 37 characters ≈ 7.4KB of query string, well
 * inside every proxy's limit; the failure above began somewhere past 400.
 */
const ID_CHUNK = 200

export async function loadQuestionsForExport(brandId: string): Promise<ExportRow[]> {
  const supabase = await createClient()

  type QuestionRow = {
    id: string
    external_id: string | null
    difficulty: ExportRow['difficulty']
    qtype: ExportRow['qtype']
    status: ExportRow['status']
    topic_id: string | null
    correct_option: string | null
  }

  const questions: QuestionRow[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('bank_questions')
      .select('id, external_id, difficulty, qtype, status, topic_id, correct_option')
      .eq('brand_id', brandId)
      .is('deleted_at', null)
      // A STABLE tiebreak. Ordering by difficulty alone leaves rows within a
      // level in no defined order, and paging an unordered set can repeat one
      // row and skip another.
      .order('difficulty')
      .order('id')
      .range(from, from + PAGE - 1)

    if (error) throw new Error(`The question bank could not be read: ${error.message}`)
    if (!data || data.length === 0) break

    questions.push(...(data as QuestionRow[]))
    if (data.length < PAGE) break
  }

  if (questions.length === 0) return []

  const ids = questions.map((q) => q.id)

  type TextRow = {
    question_id: string
    locale: string
    question: string
    option_a: string | null
    option_b: string | null
    option_c: string | null
    option_d: string | null
    answer_text: string | null
    explanation: string | null
  }

  // Chunked, and every failure is thrown rather than folded into an empty list.
  const textRows: TextRow[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const slice = ids.slice(i, i + ID_CHUNK)
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('bank_question_texts')
        .select('question_id, locale, question, option_a, option_b, option_c, option_d, answer_text, explanation')
        .in('question_id', slice)
        .order('question_id')
        .order('locale')
        .range(from, from + PAGE - 1)

      if (error) throw new Error(`The question text could not be read: ${error.message}`)
      if (!data || data.length === 0) break

      textRows.push(...(data as TextRow[]))
      if (data.length < PAGE) break
    }
  }

  const { data: topicRows } = await supabase.from('question_topics').select('id, slug')
  const topicSlug = new Map((topicRows ?? []).map((t) => [t.id, t.slug]))

  /*
   * The invariant the old code could not state: a question with no text is a
   * question that will be rejected on re-import. If the texts came back empty
   * for EVERY question, something upstream failed rather than the bank being
   * genuinely textless — 0054's trigger will not let an active question exist
   * without text.
   */
  if (textRows.length === 0) {
    throw new Error(
      `The question bank returned ${questions.length} questions and no text at all. ` +
        'Refusing to write an export that would re-import as empty.',
    )
  }

  const byQuestion = new Map<string, ExportRow['texts']>()
  for (const row of textRows) {
    const list = byQuestion.get(row.question_id) ?? []
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
    byQuestion.set(row.question_id, list)
  }

  return questions.map((q) => ({
    externalId: q.external_id,
    difficulty: q.difficulty,
    qtype: q.qtype,
    status: q.status,
    topicSlug: q.topic_id ? (topicSlug.get(q.topic_id) ?? null) : null,
    correctOption: q.correct_option,
    /*
     * ALWAYS NULL NOW, AND THE FIELDS STAY IN THE CONTRACT ON PURPOSE.
     *
     * The document library is gone, so nothing can be cited and nothing can be
     * resolved back to a title. The two keys remain in the export envelope
     * because the import format was frozen with them and files generated
     * against that contract must keep importing — see src/lib/bank/import.
     *
     * Consequence, stated plainly: a `reference` sent in is accepted and
     * ignored, and does not come back out.
     */
    referenceTitle: null,
    referencePage: null,
    texts: byQuestion.get(q.id) ?? [],
  }))
}

/**
 * One question, with every language it has.
 *
 * Returns null for "not found" and "not yours" alike — RLS makes another
 * company's question simply absent, and those are the same answer to a user.
 */
export async function loadQuestion(id: string): Promise<BankQuestionRow | null> {
  const supabase = await createClient()
  const claims = await getAppClaims()

  /*
   * ONE STRING LITERAL, not a concatenation.
   *
   * supabase-js infers the row shape from the select string as a LITERAL type.
   * Splitting it with `+` across lines produces plain `string`, inference
   * gives up, and every column comes back as GenericStringError — which reads
   * like a database problem and is purely a TypeScript one.
   */
  const { data, error } = await supabase
    .from('bank_questions')
    .select('id, brand_id, difficulty, qtype, status, topic_id, correct_option, created_by, created_at, updated_at, deleted_at')
    .eq('id', id)
    .maybeSingle()

  if (error || !data) return null

  // Separate queries rather than embeds — gen-types.mjs emits
  // `Relationships: []`, so an embedded select cannot be typed. Same reason as
  // loadPaperHistory in availability.ts.
  const [texts, topic, brand, author] = await Promise.all([
    supabase
      .from('bank_question_texts')
      .select('locale, question, option_a, option_b, option_c, option_d, answer_text')
      .eq('question_id', id),
    data.topic_id
      ? supabase.from('question_topics').select('name').eq('id', data.topic_id).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from('brands').select('name').eq('id', data.brand_id).maybeSingle(),
    supabase.from('profiles').select('full_name').eq('id', data.created_by).maybeSingle(),
  ])

  const byLocale: BankQuestionRow['texts'] = {}
  const complete: BankLocale[] = []

  for (const row of texts.data ?? []) {
    const locale = row.locale as BankLocale
    if (!(BANK_LOCALES as readonly string[]).includes(locale)) continue

    byLocale[locale] = {
      question: row.question,
      optionA: row.option_a,
      optionB: row.option_b,
      optionC: row.option_c,
      optionD: row.option_d,
      answerText: row.answer_text,
    }

    const filled =
      data.qtype === 'mcq'
        ? Boolean(row.option_a && row.option_b && row.option_c && row.option_d)
        : Boolean(row.answer_text)
    if (row.question && filled) complete.push(locale)
  }

  return {
    // Present ONLY for an Editor. Everybody else gets undefined, and the field
    // is absent from the payload rather than blanked.
    id: canSeeQuestionUuid(claims) ? data.id : undefined,
    rowKey: data.id,
    brandId: data.brand_id,
    brandName: brand.data?.name ?? '',
    difficulty: data.difficulty,
    qtype: data.qtype,
    status: data.status,
    topicId: data.topic_id,
    topicName: topic.data?.name ?? null,
    correctOption: data.correct_option as BankQuestionRow['correctOption'],
    texts: byLocale,
    completeLocales: complete,
    createdByName: author.data?.full_name ?? '—',
    createdAt: data.created_at,
    updatedAt: data.updated_at,
    deletedAt: data.deleted_at,
  }
}
