-- ═══════════════════════════════════════════════════════════════════════════
-- 0091 — Withdrawing an unsat exam gives the paper back.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE TRAP, AS A USER ACTUALLY HIT IT TODAY: publish a paper as an online   ║
-- ║ exam, then want to change a question. paper_is_editable freezes any      ║
-- ║ paper an exam row points at — correct while the exam can be sat — and    ║
-- ║ the ONLY exit, cancelling the exam, did not unfreeze it, because the     ║
-- ║ cancelled row still exists. A one-way door: publish once and the paper   ║
-- ║ is uneditable forever. Replace, edit and save all refused, and the UI    ║
-- ║ never said why.                                                          ║
-- ║                                                                          ║
-- ║ THE RULE NOW: a CANCELLED exam that NOBODY EVER STARTED does not freeze  ║
-- ║ its paper. Withdraw the mistake before anyone sits it and the paper is   ║
-- ║ yours again.                                                             ║
-- ║                                                                          ║
-- ║ WHAT STILL FREEZES, DELIBERATELY:                                        ║
-- ║   · any live exam state — scheduled, active, completed — sat or not      ║
-- ║   · a cancelled exam WITH attempts: somebody sat those questions, and    ║
-- ║     "Paper 14" must keep meaning what it meant when they did             ║
-- ║                                                                          ║
-- ║ edit_paper_questions() calls this same function, so the screen's flag    ║
-- ║ and the save-time enforcement cannot disagree.                           ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.paper_is_editable(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.exam_papers p
     where p.id = p_paper_id
       and p.status = 'generated'
       and not exists (
         select 1 from public.exams e
          where e.paper_id = p.id
            and e.deleted_at is null
            -- 0091: a withdrawn exam nobody ever started releases its paper.
            and not (
              e.status = 'cancelled'
              and not exists (
                select 1 from public.attempts a where a.exam_id = e.id
              )
            )
       )
  );
$$;

comment on function public.paper_is_editable(uuid) is
  'Whether a paper''s questions may still be changed: status generated, and no exam holds it — where a cancelled exam that nobody ever started does not count (0091). Used by the review screen AND by edit_paper_questions, so display and enforcement share one answer.';
