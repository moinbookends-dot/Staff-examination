/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Claim a generated paper that nothing else is currently using.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS EXISTS BECAUSE THREE CHECK SCRIPTS SHARE FOUR PAPERS.                ║
 * ║                                                                           ║
 * ║ check-delivery, check-live-exams and check-marking each publish a paper   ║
 * ║ as an exam, sit it, and put the paper back in `finally`. All three ran    ║
 * ║ the SAME query — newest non-retired paper with no live exam on it — and   ║
 * ║ each threw immediately if it came back empty.                             ║
 * ║                                                                           ║
 * ║ Run one after another that is fine. Run them back to back and it is not:  ║
 * ║ the previous script's cleanup is still settling, every paper still looks  ║
 * ║ taken, and the next one dies with                                         ║
 * ║                                                                           ║
 * ║   no free paper — every generated paper is already published              ║
 * ║                                                                           ║
 * ║ That is a red build caused by timing and nothing else. It happened once   ║
 * ║ in a back-to-back sweep, passed on every individual re-run, and a check   ║
 * ║ that fails only when the suite is run as a suite is worse than no check:  ║
 * ║ people learn to re-run it until it is green.                              ║
 * ║                                                                           ║
 * ║ WAITING IS THE HONEST FIX. The contention is real but brief, so this      ║
 * ║ polls instead of giving up on the first look — and still fails loudly,    ║
 * ║ with the actual state of the table, when the pool is genuinely exhausted. ║
 * ║ It does not create papers: a check that quietly manufactures its own      ║
 * ║ fixture stops testing the thing the product actually has.                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

/*
 * The union of what the three callers need, so none of them has to re-query.
 * check-delivery asserts on mcq_n/short_n, check-live-exams on marks, and all
 * three restore status/status_changed_* in their `finally`.
 */
const FREE_PAPER = `
  select p.id, p.paper_no, p.marks, p.mcq_n, p.short_n,
         p.status, p.status_changed_at, p.status_changed_by
    from public.exam_papers p
   where p.status <> 'retired'
     and not exists (
       select 1 from public.exams e
        where e.paper_id = p.id and e.deleted_at is null
          and e.status in ('draft','scheduled','active'))
   order by p.generated_at desc
   limit 1`

/**
 * A paper that can still be EDITED, which is a stricter thing than a free one.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ FREE ≠ EDITABLE, AND THE DIFFERENCE IS PERMANENT.                         │
 * │                                                                           │
 * │ claimFreePaper() returns any paper with no OPEN exam — which includes a   │
 * │ paper that was published once and whose exam has since been closed or     │
 * │ deleted. Such a paper is `live` forever: set_paper_status() refuses to    │
 * │ return anything to `generated` (0061), by design, because a paper that    │
 * │ has been issued must never look unissued.                                 │
 * │                                                                           │
 * │ paper_is_editable() (0072) therefore requires BOTH `generated` and no     │
 * │ exam at all. check-paper-edit.mjs asked for a free paper, was handed a    │
 * │ `live` one, and reported six failures that were entirely about the        │
 * │ fixture rather than the feature — which is exactly the kind of red that   │
 * │ teaches people to ignore red.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function claimEditablePaper(db, waitSeconds = 30) {
  const paper = await claimFreePaper(db, waitSeconds, EDITABLE_PAPER)
  return paper
}

const EDITABLE_PAPER = `
  select p.id, p.paper_no, p.marks, p.mcq_n, p.short_n,
         p.status, p.status_changed_at, p.status_changed_by
    from public.exam_papers p
   where p.status = 'generated'
     and not exists (
       select 1 from public.exams e
        where e.paper_id = p.id and e.deleted_at is null)
   order by p.generated_at desc
   limit 1`

/**
 * @param db          a connected pg.Client
 * @param waitSeconds how long to keep looking before giving up
 * @param sql         which flavour of "available" to ask for
 */
export async function claimFreePaper(db, waitSeconds = 30, sql = null) {
  const deadline = Date.now() + waitSeconds * 1000
  let announced = false

  for (;;) {
    const { rows } = await db.query(sql ?? FREE_PAPER)
    if (rows[0]) return rows[0]

    if (Date.now() >= deadline) break

    if (!announced) {
      console.log(
        `  …every paper is currently published. Waiting up to ${waitSeconds}s for ` +
          'another check script to put one back.',
      )
      announced = true
    }
    await new Promise((r) => setTimeout(r, 2000))
  }

  // Say what is actually true, so the failure is diagnosable rather than a
  // sentence to re-run past.
  const { rows: state } = await db.query(
    `select p.paper_no, p.status,
            (select string_agg(e.status::text, ',') from public.exams e
              where e.paper_id = p.id and e.deleted_at is null) as exams
       from public.exam_papers p order by p.generated_at desc`,
  )
  throw new Error(
    `no free paper after ${waitSeconds}s. exam_papers:\n` +
      state.map((r) => `      #${r.paper_no} ${r.status} → exams: ${r.exams ?? 'none'}`).join('\n') +
      '\n    A paper stuck behind a draft/scheduled/active exam means an earlier run ' +
      'did not clean up; delete that exam and re-run.',
  )
}
