import { getAppClaims } from '@/lib/auth/claims'
import { canOpenQuestionBank } from '@/lib/auth/bank-access'
import { can } from '@/lib/auth/can'
import { createClient } from '@/lib/supabase/server'
import { loadQuestionsForExport } from '@/server/papers/bank-data'
import { exportFilename, toExportEnvelope } from '@/lib/bank/import/export'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GET /api/bank/export?brand=<uuid> — the question bank as an importable file.
 *
 * Lives under /api rather than under [locale] because src/proxy.ts excludes
 * /api from locale routing, and a download must not be redirected to /en/… on
 * its way out. The reports CSV route makes the same argument.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ AUTHORISATION IS THIS FILE'S OWN JOB, AND IT IS NOT THE SUBTREE'S.        ║
 * ║                                                                           ║
 * ║ /questions/* is gated by a layout on canOpenQuestionBank. THIS ROUTE IS   ║
 * ║ NOT UNDER THAT LAYOUT — it is not even under the locale segment — so none ║
 * ║ of that applies here and nothing has checked the session before this      ║
 * ║ function runs.                                                            ║
 * ║                                                                           ║
 * ║ It therefore repeats the full check: canOpenQuestionBank (which is what   ║
 * ║ locks a Super Admin out, since has_perm cannot express a denial) AND      ║
 * ║ bank.export. Getting this wrong would hand the entire question bank to    ║
 * ║ anybody who could guess the URL — which is exactly what an exam bank      ║
 * ║ must never do.                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The 403s below are deliberately indistinguishable from each other: a caller
 * who may not export learns nothing about which brands exist.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const claims = await getAppClaims()

  if (!canOpenQuestionBank(claims) || !can(claims, 'bank.export') || !claims.company_id) {
    return new Response('Not permitted.', { status: 403 })
  }

  const requested = new URL(request.url).searchParams.get('brand')

  /*
   * A brand-pinned Editor exports their own brand whatever the query string
   * says. RLS would filter another brand's questions to nothing anyway, but an
   * empty file is a confusing answer to an unauthorised request — pinning it
   * makes the parameter unable to lie.
   */
  const brandId = claims.brand_id ?? requested
  if (!brandId) return new Response('Choose a brand to export.', { status: 400 })

  const supabase = await createClient()
  const { data: brand } = await supabase
    .from('brands')
    .select('name')
    .eq('id', brandId)
    .is('deleted_at', null)
    .maybeSingle()

  // RLS makes another company's brand simply absent, so "not found" and "not
  // yours" are the same answer.
  if (!brand) return new Response('Not permitted.', { status: 403 })

  const rows = await loadQuestionsForExport(brandId)
  const exportedAt = new Date().toISOString()

  const envelope = toExportEnvelope(rows, { brand: brand.name, exportedAt })

  /*
   * Pretty-printed with two spaces.
   *
   * The file is meant to be opened, diffed and hand-corrected before being
   * re-imported — that is the whole workflow it exists for. Minifying it to
   * save bytes on a download somebody performs once would make the one thing
   * it is for much harder.
   */
  return new Response(JSON.stringify(envelope, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFilename(brand.name, exportedAt)}"`,
      // A question bank is not something a shared cache should keep.
      'Cache-Control': 'no-store, private',
    },
  })
}
