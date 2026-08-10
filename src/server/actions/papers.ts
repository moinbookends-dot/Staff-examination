'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAppClaims } from '@/lib/auth/claims'
import { canGeneratePapers } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { DIFFICULTIES } from '@/lib/bank/vocabulary'
import { PAPER_SIZES } from '@/lib/papers/blueprint'
import { generatePaper as runGenerator } from '@/lib/papers/generate'
import { createPaperRepository } from '@/server/papers/repository'
import type { GenerateOutcome } from '@/components/papers/generate-panel'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Generate a paper.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ACTION DECIDES NOTHING ABOUT HOW A PAPER IS BUILT.                   ║
 * ║                                                                           ║
 * ║ The draw, the 80/20 blueprint, the never-twice rule, the exhaustion       ║
 * ║ arithmetic and the retry loop all live in src/lib/papers/generate.ts,     ║
 * ║ which is unit-tested against a fake repository. Re-deriving any of it     ║
 * ║ here would create a second implementation that the tests do not cover —   ║
 * ║ and the two would drift.                                                  ║
 * ║                                                                           ║
 * ║ So this file does four things and stops: check the caller, resolve the    ║
 * ║ brand, run the generator, and translate its result into the union the     ║
 * ║ panel renders.                                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Passing this as `onGenerate` is what enables the button: GeneratePanel gates
 * on the prop being present rather than on a separate "is it wired" flag, so
 * until this existed the control was disabled by construction.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const generateInput = z.object({
  difficulty: z.enum(DIFFICULTIES),
  // Only the sizes the product offers. blueprintFor() would throw on anything
  // that cannot split 80/20 into whole questions, and a thrown error inside a
  // Server Action has no boundary to catch it.
  marks: z.union([z.literal(PAPER_SIZES[0]), z.literal(PAPER_SIZES[1])]),
  brandId: dbId().optional(),
})

const DENIED = 'You are not permitted to generate papers.'

export async function generatePaper(raw: unknown): Promise<GenerateOutcome> {
  const claims = await getAppClaims()

  if (!canGeneratePapers(claims) || !claims.userId || !claims.company_id) {
    return { status: 'failed', message: DENIED }
  }

  const parsed = generateInput.safeParse(raw)
  if (!parsed.success) {
    return { status: 'failed', message: 'Choose a level and a paper size.' }
  }
  const input = parsed.data

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE PINNED BRAND WINS OVER ANYTHING THE CLIENT SENT.                    │
   * │                                                                         │
   * │ Same precedence as /api/bank/export: `claims.brand_id ?? requested`. A  │
   * │ Chef pinned to one brand cannot widen their scope by editing the        │
   * │ payload, because their own claim is consulted first and the request's   │
   * │ value is never reached.                                                 │
   * │                                                                         │
   * │ 0059's functions re-check this too — brand_in_my_company() — so a       │
   * │ forged brand fails at the database as well. This is the readable copy.  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const brandId = claims.brand_id ?? input.brandId
  if (!brandId) {
    return { status: 'failed', message: 'Choose a brand to generate from.' }
  }

  // RLS makes another company's brand simply absent, so "not found" and "not
  // yours" are the same answer.
  const supabase = await createClient()
  const { data: brand } = await supabase
    .from('brands')
    .select('id')
    .eq('id', brandId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!brand) return { status: 'failed', message: DENIED }

  const scope = {
    companyId: claims.company_id,
    brandId,
    difficulty: input.difficulty,
    marks: input.marks,
  }

  let result
  try {
    result = await runGenerator(
      { scope, generatedBy: claims.userId },
      createPaperRepository(scope),
    )
  } catch (err) {
    /*
     * The repository throws for a refused permission, an unknown brand, or a
     * question that stopped being active mid-draw. Reported as a failed
     * outcome rather than allowed to escape: an unhandled throw in a Server
     * Action reaches the client as an opaque digest with no message at all.
     */
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'The paper could not be generated.',
    }
  }

  switch (result.status) {
    case 'generated':
      // The paper now exists in history and changes the dashboard counts.
      revalidatePath('/history')
      revalidatePath('/dashboard')
      revalidatePath('/papers/generate')

      return {
        status: 'generated',
        paperId: result.paperId,
        paperNo: result.paperNo,
        totalCombinations: result.totalCombinations,
        unlimited: result.unlimited,
      }

    case 'short':
      // `marks` rather than the whole blueprint: the panel prints "needs 16,
      // has 9" per type and derives nothing else from it.
      return { status: 'short', shortfalls: result.shortfalls, marks: result.blueprint.marks }

    case 'exhausted':
      return { status: 'exhausted' }

    default:
      return { status: 'failed', message: result.message }
  }
}
