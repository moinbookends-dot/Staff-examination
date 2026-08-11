import 'server-only'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { examState, type ExamState, type StoredExamStatus } from '@/lib/exams/state'
import type { AssignmentTarget } from '@/lib/exams/rules'
import type { BankLocale, Difficulty } from '@/lib/bank/vocabulary'
import { DIFFICULTIES } from '@/lib/bank/vocabulary'
import { blueprintFor, PAPER_SIZES, type PaperBlueprint } from '@/lib/papers/blueprint'
import { totalPossiblePapers, type PoolCounts } from '@/lib/papers/combinations'
import type { PaperHistoryEntry, PaperHistoryPage } from '@/lib/papers/repository'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE DATA BOUNDARY for papers.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY READ GOES THROUGH THE CALLER'S OWN CLIENT. RLS IS THE AUTHORISATION.║
 * ║                                                                           ║
 * ║ createClient() carries the user's JWT, so each query below is evaluated   ║
 * ║ against the policies in 0055 and 0056. There is no service-role client in ║
 * ║ this file and there must not be one: a service-role read would return     ║
 * ║ rows the policies exist to withhold, and every caller above would then be ║
 * ║ responsible for re-filtering them correctly.                              ║
 * ║                                                                           ║
 * ║ CONSEQUENCE WORTH KNOWING: a chef holds papers.read_history but NO bank.* ║
 * ║ permission. So the paper queries return their rows and the bank queries   ║
 * ║ return nothing — not an error, an empty set, because RLS refuses by       ║
 * ║ FILTERING. Callers must treat "zero" as "not visible to you" rather than  ║
 * ║ "does not exist"; the screens above gate on the same predicates so the    ║
 * ║ two never disagree.                                                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Paper generation availability
// ─────────────────────────────────────────────────────────────────────────────

export interface PaperSizeOption extends PaperBlueprint {
  available: boolean
}

export interface LevelAvailability {
  difficulty: Difficulty
  pool: PoolCounts
  combinationsBySize: Record<number, number>
}

export interface GenerateAvailability {
  levels: LevelAvailability[]
  sizes: number[]
  hasQuestions: boolean
  /**
   * True when the caller cannot see the bank at all.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ A CHEF CANNOT COUNT THE POOL, AND THAT IS A REAL GAP — NOT A BUG HERE.│
   * │                                                                       │
   * │ bank_questions is readable only with bank.read (0055), which a chef   │
   * │ deliberately does not hold. So this function returns zeros for the    │
   * │ very person the Generate screen is FOR, and the screen cannot honestly │
   * │ say how many questions are available.                                 │
   * │                                                                       │
   * │ The fix is a SECURITY DEFINER function returning COUNTS ONLY — no ids, │
   * │ no text — which is what the design always called for. It needs a       │
   * │ migration and is reported rather than worked around: filling this with │
   * │ a service-role read would hand a chef numbers the policies withhold,   │
   * │ and guessing would put a made-up figure on the screen.                 │
   * │                                                                       │
   * │ Until then this flag lets the screen say "counts unavailable" instead  │
   * │ of "the bank is empty", which is the difference between an honest      │
   * │ limitation and a lie.                                                  │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  poolCountsVisible: boolean
}

/**
 * Pool counts per level, and how many distinct papers each size can still make.
 *
 * The combination arithmetic is NOT duplicated here — totalPossiblePapers()
 * from src/lib/papers/combinations.ts does it, the same function the generator
 * uses, so the number on the screen and the number that decides exhaustion
 * cannot disagree.
 */
/**
 * The RPC's result, validated rather than asserted.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ scripts/gen-types.mjs emits `Returns: unknown` for every function — it     │
 * │ introspects tables precisely and functions loosely — so supabase.rpc()     │
 * │ hands back `unknown` here.                                                │
 * │                                                                           │
 * │ Parsing it is the honest response. A cast would compile while trusting a  │
 * │ shape nothing checks, and if the function's return type ever changed the  │
 * │ failure would surface as `undefined` arithmetic somewhere downstream       │
 * │ rather than at the boundary where it happened.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const poolCountRowSchema = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard']),
  qtype: z.enum(['mcq', 'short_answer']),
  n: z.coerce.number().int().min(0),
})

export async function loadGenerateAvailability(brandId?: string): Promise<GenerateAvailability> {
  const supabase = await createClient()
  const sizes = [...PAPER_SIZES]

  /*
   * bank_pool_counts() rather than a select on bank_questions.
   *
   * A chef holds papers.generate and NOT bank.read, so the table is invisible
   * to them and a direct select returns zero rows — the Generate screen would
   * tell the person it exists for that the bank is empty. The function is
   * SECURITY DEFINER and returns COUNTS ONLY: no ids, no text, nothing that
   * could be reassembled into a question. See migration 0057.
   */
  const { data, error } = await supabase.rpc('bank_pool_counts', {
    p_brand_id: brandId ?? null,
  })

  const parsed = z.array(poolCountRowSchema).safeParse(data ?? [])
  const rows = error || !parsed.success ? [] : parsed.data

  const levels: LevelAvailability[] = DIFFICULTIES.map((difficulty) => {
    const forLevel = rows.filter((r) => r.difficulty === difficulty)
    const pool: PoolCounts = {
      mcq: forLevel.find((r) => r.qtype === 'mcq')?.n ?? 0,
      shortAnswer: forLevel.find((r) => r.qtype === 'short_answer')?.n ?? 0,
    }

    const combinationsBySize: Record<number, number> = {}
    for (const marks of sizes) {
      combinationsBySize[marks] = totalPossiblePapers(pool, blueprintFor(marks))
    }
    return { difficulty, pool, combinationsBySize }
  })

  const total = rows.reduce((sum, r) => sum + r.n, 0)

  return {
    levels,
    sizes,
    hasQuestions: total > 0,
    // An error means the counts could not be read at all — the screen says so
    // rather than rendering zeros, which would read as "the bank is empty".
    poolCountsVisible: !error && parsed.success,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface BankStatistics {
  total: number
  active: number
  draft: number
  archived: number
  byDifficulty: Record<Difficulty, number>
  papersGenerated: number
  editors: number
}

/**
 * Counts for the dashboard.
 *
 * Three independent reads run in parallel. Each returns zero for a caller
 * whose policies do not admit the table, which is why the dashboard gates each
 * block on the same predicate rather than on whether the number is non-zero.
 */
export async function loadBankStatistics(): Promise<BankStatistics> {
  const supabase = await createClient()

  const [bank, papers, editors] = await Promise.all([
    supabase.from('bank_questions').select('status, difficulty').is('deleted_at', null),
    supabase.from('exam_papers').select('id', { count: 'exact', head: true }),
    supabase
      .from('user_roles')
      .select('role_id, roles!inner(key)', { count: 'exact', head: true })
      .eq('roles.key', 'editor'),
  ])

  const rows = bank.data ?? []

  return {
    total: rows.length,
    active: rows.filter((r) => r.status === 'active').length,
    draft: rows.filter((r) => r.status === 'draft').length,
    archived: rows.filter((r) => r.status === 'archived').length,
    byDifficulty: {
      easy: rows.filter((r) => r.difficulty === 'easy').length,
      medium: rows.filter((r) => r.difficulty === 'medium').length,
      hard: rows.filter((r) => r.difficulty === 'hard').length,
    },
    papersGenerated: papers.count ?? 0,
    editors: editors.count ?? 0,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Exam history
// ─────────────────────────────────────────────────────────────────────────────

/** Which of the six files a paper has produced. */
type FileRow = { locale: string; kind: string }

function toAvailableFiles(files: FileRow[] | null): PaperHistoryEntry['availableFiles'] {
  return (files ?? [])
    .filter((f) => f.kind === 'paper' || f.kind === 'key')
    .map((f) => ({ locale: f.locale as BankLocale, kind: f.kind as 'paper' | 'key' }))
}

/**
 * Resolve the people who generated papers, in one round trip.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A SEPARATE QUERY RATHER THAN AN EMBEDDED JOIN.                            │
 * │                                                                           │
 * │ exam_papers.generated_by references profiles, so PostgREST could embed    │
 * │ it — but profiles has its own policies, and a chef may not read every     │
 * │ colleague's row. An embed that RLS filters yields null silently, and the  │
 * │ shape of that null depends on the relationship name being spelled         │
 * │ correctly, which is a runtime failure rather than a type error.           │
 * │                                                                           │
 * │ Fetching separately makes the filtering explicit: whoever is not visible  │
 * │ simply has no entry, and the caller falls back to a neutral label rather  │
 * │ than rendering "null".                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
async function resolveNames(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return new Map()

  const { data } = await supabase.from('profiles').select('id, full_name').in('id', unique)
  return new Map((data ?? []).map((p) => [p.id, p.full_name]))
}

async function resolveBrands(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(ids)].filter(Boolean)
  if (unique.length === 0) return new Map()

  const { data } = await supabase.from('brands').select('id, name').in('id', unique)
  return new Map((data ?? []).map((b) => [b.id, b.name]))
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SEPARATE QUERIES, NOT POSTGREST EMBEDS — AND THE REASON IS THE TYPE       │
 * │ GENERATOR.                                                                │
 * │                                                                           │
 * │ `select('…, exam_paper_questions(count)')` is the natural way to write    │
 * │ this, and it does not typecheck here: scripts/gen-types.mjs emits         │
 * │ `Relationships: []` for all 45 tables, so supabase-js has no foreign-key  │
 * │ metadata to resolve an embed against and every embedded column degrades   │
 * │ to GenericStringError.                                                    │
 * │                                                                           │
 * │ Fetching the children by `in (…)` costs two extra round trips on a page   │
 * │ of 25 and types exactly. The alternative — casting the embed through      │
 * │ `unknown` — would compile while silently inventing a shape nothing        │
 * │ verifies, which is the failure this project has twice deleted type shims  │
 * │ to avoid. Teaching the generator to emit relationships is a separate,     │
 * │ larger change.                                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function loadPaperHistory(page = 1, pageSize = 25): Promise<PaperHistoryPage> {
  const supabase = await createClient()

  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  const { data, count, error } = await supabase
    .from('exam_papers')
    .select(
      'id, paper_no, brand_id, difficulty, marks, mcq_n, short_n, generated_at, generated_by, status, status_changed_at',
      { count: 'exact' },
    )
    .order('generated_at', { ascending: false })
    .range(from, to)

  if (error || !data || data.length === 0) {
    return { rows: [], total: count ?? 0, page, pageSize }
  }

  const paperIds = data.map((p) => p.id)

  const [questions, files, names, brands] = await Promise.all([
    supabase.from('exam_paper_questions').select('paper_id').in('paper_id', paperIds),
    supabase.from('exam_paper_files').select('paper_id, locale, kind').in('paper_id', paperIds),
    resolveNames(supabase, data.map((p) => p.generated_by)),
    resolveBrands(supabase, data.map((p) => p.brand_id)),
  ])

  const countByPaper = new Map<string, number>()
  for (const q of questions.data ?? []) {
    countByPaper.set(q.paper_id, (countByPaper.get(q.paper_id) ?? 0) + 1)
  }

  const filesByPaper = new Map<string, FileRow[]>()
  for (const f of files.data ?? []) {
    const list = filesByPaper.get(f.paper_id) ?? []
    list.push({ locale: f.locale, kind: f.kind })
    filesByPaper.set(f.paper_id, list)
  }

  const rows: PaperHistoryEntry[] = data.map((p) => ({
    id: p.id,
    paperNo: p.paper_no,
    brandId: p.brand_id,
    brandName: brands.get(p.brand_id) ?? '',
    difficulty: p.difficulty,
    marks: p.marks,
    questionCount: countByPaper.get(p.id) ?? 0,
    generatedByName: names.get(p.generated_by) ?? '—',
    generatedAt: p.generated_at,
    status: p.status,
    statusChangedAt: p.status_changed_at,
    availableFiles: toAvailableFiles(filesByPaper.get(p.id) ?? []),
  }))

  return { rows, total: count ?? rows.length, page, pageSize }
}

// ─────────────────────────────────────────────────────────────────────────────
// One paper
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A paper's composition as the details page can honestly show it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SECTION COUNTS, NOT QUESTION TEXT.                                        │
 * │                                                                           │
 * │ exam_paper_questions is readable with papers.read_history, so the shape   │
 * │ of a paper — how many of each type, in what order — is available to a     │
 * │ chef. The question TEXT lives in bank_question_texts, which requires      │
 * │ bank.read, which a chef does not hold.                                    │
 * │                                                                           │
 * │ So this returns the composition and NOT the text. Rendering the text for  │
 * │ a chef needs the planned SECURITY DEFINER read function; it is not done   │
 * │ by reaching around RLS with a service-role client.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export interface PaperDetail extends PaperHistoryEntry {
  blueprint: PaperBlueprint
  /** questionNo → section, in printed order. */
  composition: { questionNo: number; section: 'mcq' | 'short_answer' }[]
  mcqCount: number
  shortAnswerCount: number
  /**
   * The open exam delivering this paper online, if there is one.
   *
   * `assignmentCount` is here for one reason: an exam with no audience is
   * invisible to every candidate, and publishing does not set one. Without
   * this the screen cannot tell "published and running" from "published and
   * nobody can see it", and those look identical to whoever pressed the button.
   */
  liveExam: {
    id: string
    title: string
    status: StoredExamStatus
    /** Derived from the window — draft / scheduled / live / closed / cancelled. */
    state: ExamState
    opensAt: string | null
    closesAt: string | null
    durationMinutes: number
    passMarkPercent: number
    resultsRelease: 'immediate' | 'on_close'
    assignmentCount: number
    /** The rows themselves, so the paper page can edit the audience in place. */
    assignments: {
      id: string
      target_kind: AssignmentTarget
      target_id: string | null
      target_role: string | null
      target_user_id: string | null
    }[]
    /**
     * True while 0062's partial index would refuse a second exam for this
     * paper. A closed or cancelled exam leaves the paper publishable again,
     * and the page needs to tell those apart to decide which control to show.
     */
    blocksRepublish: boolean
  } | null
}

export async function loadPaperDetail(paperId: string): Promise<PaperDetail | null> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('exam_papers')
    .select('id, paper_no, brand_id, difficulty, marks, mcq_n, short_n, generated_at, generated_by, status, status_changed_at')
    .eq('id', paperId)
    .maybeSingle()

  // Null covers both "no such paper" and "not yours" — RLS makes another
  // company's paper simply absent, and those are the same answer to a user.
  if (error || !data) return null

  // Separate queries rather than embeds. See the box on loadPaperHistory.
  const [questions, files, names, brands, exams] = await Promise.all([
    supabase
      .from('exam_paper_questions')
      .select('question_no, section')
      .eq('paper_id', paperId)
      .order('question_no'),
    supabase.from('exam_paper_files').select('locale, kind').eq('paper_id', paperId),
    resolveNames(supabase, [data.generated_by]),
    resolveBrands(supabase, [data.brand_id]),
    /*
     * The open exam, if any. 0062's partial unique index allows at most one, so
     * maybeSingle is safe rather than optimistic.
     *
     * A reader without exams.read gets nothing back from RLS and simply sees no
     * publishing state — which is correct: they are not the person who acts on
     * it. The count is fetched separately for the same reason the rest of this
     * function avoids embeds.
     */
    supabase
      .from('exams')
      .select('id, title, status, opens_at, closes_at, duration_minutes, pass_mark_percent, results_release')
      .eq('paper_id', paperId)
      .is('deleted_at', null)
      /*
       * ANY status, newest first — not just the open ones.
       *
       * This was scoped to draft/scheduled/active because its only job was
       * gating the publish form. Now the paper page also shows who sat the
       * exam, and a CLOSED exam is exactly when that record matters most.
       * `blocksRepublish` carries the old meaning so the publish gate is
       * unchanged.
       */
      .order('published_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  let liveExam: PaperDetail['liveExam'] = null
  if (exams.data) {
    /*
     * The assignment ROWS, not just a count.
     *
     * The count alone was enough while the audience was edited on a different
     * page. Now that the paper page owns it, the picker needs the actual
     * targets — and fetching them here keeps the page a single round of
     * server work rather than a client fetch after paint.
     */
    const { data: rows } = await supabase
      .from('exam_assignments')
      .select('id, target_kind, target_id, target_role, target_user_id')
      .eq('exam_id', exams.data.id)

    const assignments = (rows ?? []) as PaperDetail['liveExam'] extends null
      ? never
      : NonNullable<PaperDetail['liveExam']>['assignments']

    liveExam = {
      id: exams.data.id,
      title: exams.data.title,
      status: exams.data.status,
      state: examState({
        status: exams.data.status,
        opensAt: exams.data.opens_at,
        closesAt: exams.data.closes_at,
      }),
      opensAt: exams.data.opens_at,
      closesAt: exams.data.closes_at,
      durationMinutes: exams.data.duration_minutes,
      passMarkPercent: exams.data.pass_mark_percent,
      resultsRelease: exams.data.results_release,
      assignmentCount: assignments.length,
      assignments,
      // Mirrors 0062's partial index exactly.
      blocksRepublish: ['draft', 'scheduled', 'active'].includes(exams.data.status),
    }
  }

  const composition = (questions.data ?? []).map((q) => ({
    questionNo: q.question_no,
    section: q.section,
  }))

  return {
    id: data.id,
    paperNo: data.paper_no,
    brandId: data.brand_id,
    brandName: brands.get(data.brand_id) ?? '',
    difficulty: data.difficulty,
    marks: data.marks,
    questionCount: composition.length,
    generatedByName: names.get(data.generated_by) ?? '—',
    generatedAt: data.generated_at,
    status: data.status,
    statusChangedAt: data.status_changed_at,
    availableFiles: toAvailableFiles(files.data ?? []),
    // Recorded ON the paper, not re-derived: paper_settings is editable, and a
    // paper generated under 16+4 must still report 16+4 afterwards.
    blueprint: { marks: data.marks, mcqCount: data.mcq_n, shortAnswerCount: data.short_n },
    composition,
    mcqCount: composition.filter((q) => q.section === 'mcq').length,
    shortAnswerCount: composition.filter((q) => q.section === 'short_answer').length,
    liveExam,
  }
}
