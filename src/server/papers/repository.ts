import 'server-only'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { ALL_ITEMS, ALL_TOPICS } from '@/lib/papers/repository'
import type {
  PaperRepository,
  PaperScope,
  SavePaperInput,
  SavePaperOutcome,
} from '@/lib/papers/repository'
import type { PoolCounts } from '@/lib/papers/combinations'
import type { QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PaperRepository, against Postgres.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ADAPTER THE INTERFACE WAS WRITTEN FOR, AND NOTHING MORE.              ║
 * ║                                                                           ║
 * ║ repository.ts is explicit about what must never happen here: "business    ║
 * ║ rules leaking into an implementation of this interface. drawQuestionIds   ║
 * ║ returns a random sample and nothing more — it does not decide how many to ║
 * ║ draw, does not know about 80/20, and must never filter by anything the    ║
 * ║ caller did not ask for."                                                  ║
 * ║                                                                           ║
 * ║ So every method below is one RPC call and a shape check. The algorithm    ║
 * ║ stays in src/lib/papers/generate.ts, where it is unit-tested against a    ║
 * ║ fake, and gains no second implementation here.                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * EVERY CALL GOES THROUGH A SECURITY DEFINER FUNCTION, and that is not a
 * shortcut. A Chef holds papers.generate and NO bank.* permission — 0055 gives
 * them no policy on bank_questions at all — so a direct select would return
 * zero rows and the generator would report an empty bank to the one role it
 * exists to serve. 0059 supplies the functions; each re-checks the caller.
 *
 * gen-types.mjs emits `Returns: unknown` for every function, so each result is
 * parsed with Zod at the boundary rather than asserted — the same treatment
 * bank_pool_counts gets in availability.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const poolRowSchema = z.object({
  difficulty: z.string(),
  qtype: z.string(),
  n: z.number().int(),
})

const drawRowSchema = z.object({ id: z.string().uuid() })

/** bank_eligible_counts — the pool that survives every filter. */
const eligibleRowSchema = z.object({
  qtype: z.enum(['mcq', 'short_answer']),
  n: z.number().int().nonnegative(),
})

const stateRowSchema = z.object({
  epoch: z.number().int(),
  generated: z.number().int(),
})

const saveResultSchema = z.union([
  z.object({
    status: z.literal('saved'),
    paperId: z.string().uuid(),
    paperNo: z.number().int(),
  }),
  z.object({ status: z.literal('duplicate') }),
])

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SCOPE IS TAKEN AT CONSTRUCTION AS WELL AS PER CALL, AND IT HAS TO BE. │
 * │                                                                           │
 * │ PaperRepository.currentEpoch receives only a companyId, because an epoch  │
 * │ is a per-company counter. But 0059's paper_generation_state answers for a │
 * │ SCOPE — it returns the epoch together with how many papers already exist  │
 * │ in it — and reaching paper_counters any other way is impossible: the      │
 * │ table has RLS enabled and no policies at all, by design in 0056.          │
 * │                                                                           │
 * │ A repository instance is built per generation request, so closing over    │
 * │ that request's scope is honest rather than stateful. The interface's own  │
 * │ arguments still win wherever they are supplied.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
/**
 * The whole level's pool, unfiltered by topic.
 *
 * Kept on bank_pool_counts so this and the dashboard still share one
 * definition of "available" — the two must never disagree.
 */
async function unfilteredPool(
  supabase: Awaited<ReturnType<typeof createClient>>,
  scope: PaperScope,
): Promise<PoolCounts> {
  const { data, error } = await supabase.rpc('bank_pool_counts', {
    p_brand_id: scope.brandId,
  })

  if (error) throw new Error(`Could not read the question pool: ${error.message}`)

  const rows = z.array(poolRowSchema).parse(data ?? [])

  /*
   * bank_pool_counts returns every difficulty and type for the brand; the
   * scope wants one difficulty. Filtered here rather than in SQL so that
   * function stays the single read the dashboard and this both use — the
   * two must never disagree about what "available" means.
   */
  const forLevel = rows.filter((row) => row.difficulty === scope.difficulty)

  return {
    mcq: forLevel.find((r) => r.qtype === 'mcq')?.n ?? 0,
    shortAnswer: forLevel.find((r) => r.qtype === 'short_answer')?.n ?? 0,
  }
}
export function createPaperRepository(requestScope: PaperScope): PaperRepository {
  async function generationState(scope: PaperScope) {
    const supabase = await createClient()

    const { data, error } = await supabase.rpc('paper_generation_state', {
      p_brand_id: scope.brandId,
      p_difficulty: scope.difficulty,
      p_marks: scope.marks,
    })

    if (error) throw new Error(`Could not read generation state: ${error.message}`)

    const rows = z.array(stateRowSchema).parse(data ?? [])
    // A company that has never generated has no counter row; 0059 answers
    // epoch 1 in that case, and an empty result means the same thing.
    return rows[0] ?? { epoch: 1, generated: 0 }
  }

  return {
    async countPool(scope: PaperScope): Promise<PoolCounts> {
      const supabase = await createClient()
      const topics = scope.topics ?? ALL_TOPICS

      /*
       * ┌─────────────────────────────────────────────────────────────────────┐
       * │ THE COUNT MUST BE THE POOL THE DRAW WILL SEE.                       │
       * │                                                                     │
       * │ An unfiltered scope keeps using bank_pool_counts, so the dashboard  │
       * │ and this still share one definition of "available". A FILTERED      │
       * │ scope has to ask the topic-aware function instead: counting a whole │
       * │ level and then drawing from a subset of it is how a generator       │
       * │ promises 1,030 questions and produces a paper it cannot fill.       │
       * └─────────────────────────────────────────────────────────────────────┘
       */
      const items = scope.items ?? ALL_ITEMS

      const unfiltered =
        topics.topicIds === null &&
        topics.includeNoTopic &&
        items.excludedItemIds.length === 0 &&
        items.includeNoItem

      if (unfiltered) return unfilteredPool(supabase, scope)

      /*
       * COUNTED BY THE DATABASE, NOT BY SUBTRACTION.
       *
       * A question can name two items, so it appears under both in the
       * per-item figures — subtracting those from the level total would
       * remove such a question twice and report a pool smaller than the one
       * the draw finds. bank_eligible_counts applies the same predicates as
       * the draw and counts questions, so the two cannot disagree.
       */
      const { data, error } = await supabase.rpc('bank_eligible_counts', {
        p_brand_id: scope.brandId,
        p_difficulty: scope.difficulty,
        p_topic_ids: topics.topicIds,
        p_include_no_topic: topics.includeNoTopic,
        p_exclude_item_ids: items.excludedItemIds,
        p_include_no_item: items.includeNoItem,
      })

      if (error) throw new Error(`Could not read the question pool: ${error.message}`)

      const rows = z.array(eligibleRowSchema).parse(data ?? [])

      return {
        mcq: rows.find((r) => r.qtype === 'mcq')?.n ?? 0,
        shortAnswer: rows.find((r) => r.qtype === 'short_answer')?.n ?? 0,
      }
    },

    async drawQuestionIds(
      scope: PaperScope,
      qtype: QuestionType,
      count: number,
    ): Promise<string[]> {
      const supabase = await createClient()

      const topics = scope.topics ?? ALL_TOPICS
      const items = scope.items ?? ALL_ITEMS

      const { data, error } = await supabase.rpc('bank_draw_question_ids', {
        p_brand_id: scope.brandId,
        p_difficulty: scope.difficulty,
        p_qtype: qtype,
        p_count: count,
        p_exclude_item_ids: items.excludedItemIds,
        p_include_no_item: items.includeNoItem,
        // Filtered inside the draw, before the random sample is taken —
        // see 0078. Excluding after the sample would return a short paper.
        p_topic_ids: topics.topicIds,
        p_include_no_topic: topics.includeNoTopic,
      })

      if (error) throw new Error(`Could not draw questions: ${error.message}`)

      // May legitimately return fewer than `count`. The caller checks and
      // reports a shortfall; padding here would produce a wrong paper silently.
      return z
        .array(drawRowSchema)
        .parse(data ?? [])
        .map((row) => row.id)
    },

    async currentEpoch(): Promise<number> {
      return (await generationState(requestScope)).epoch
    },

    async countGenerated(scope: PaperScope): Promise<number> {
      return (await generationState(scope)).generated
    },

    async save(input: SavePaperInput): Promise<SavePaperOutcome> {
      const supabase = await createClient()

      const { data, error } = await supabase.rpc('save_exam_paper', {
        p_brand_id: input.scope.brandId,
        p_difficulty: input.scope.difficulty,
        p_marks: input.blueprint.marks,
        p_mcq_n: input.blueprint.mcqCount,
        p_short_n: input.blueprint.shortAnswerCount,
        p_epoch: input.epoch,
        // combinationHash is already the hex digest (paper-hash.ts). bytea over
        // PostgREST is hex with a leading \x — NOT base64, which is what the
        // node pg driver would have wanted and is the easy thing to get wrong.
        p_combination_hash: `\\x${input.combinationHash}`,
        p_config: input.config ?? null,
        p_questions: input.questions.map((q) => ({
          questionId: q.id,
          questionNo: q.questionNo,
          section: q.section,
        })),
      })

      /*
       * A duplicate is a RETURN VALUE here, never an error: 0059 catches the
       * unique violation and answers {"status":"duplicate"}, which generate.ts
       * responds to by drawing again. Anything reaching `error` is a genuine
       * failure — a refused permission, an unknown brand, a question that is no
       * longer active.
       */
      if (error) throw new Error(`Could not save the paper: ${error.message}`)

      return saveResultSchema.parse(data)
    },
  }
}
