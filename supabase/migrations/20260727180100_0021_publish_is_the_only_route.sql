-- ═════════════════════════════════════════════════════════════════════════════
-- 0021 — publish_exam() is the ONLY route out of draft
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT WAS WRONG                                                            │
-- │                                                                           │
-- │ 0014's exams_published_has_paper CHECK reads                              │
-- │                                                                           │
-- │   status = 'draft' or paper_mode = 'per_attempt' or (published_at ...)    │
-- │                                                                           │
-- │ The `paper_mode = 'per_attempt'` disjunct was there because such an exam  │
-- │ freezes no paper, so question_count is legitimately null. But it exempts  │
-- │ the row from EVERY other condition too, including published_at.           │
-- │                                                                           │
-- │ Consequence, confirmed by experiment: a per_attempt exam with no          │
-- │ sections, no rules and no health check at all could be moved straight to  │
-- │ 'scheduled' by a plain UPDATE —                                           │
-- │                                                                           │
-- │   update exams set status='scheduled' where id=…   →   accepted           │
-- │                                                                           │
-- │ — and 0016 then locked it forever. No paper, no notifications, no email,  │
-- │ published_at null, and unfixable without a duplicate. The same UPDATE on  │
-- │ a 'fixed' exam was correctly refused, which is why this went unnoticed.   │
-- │                                                                           │
-- │ The application had the same hole: setExamStatus accepted 'scheduled',    │
-- │ requiring only exams.update, so it bypassed publish_exam's exams.publish  │
-- │ check AND its exam_health gate. That half is fixed in                     │
-- │ src/server/actions/exams.ts; this is the half that also binds psql,       │
-- │ imports and anything else that reaches the database.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- THE RULE, STATED ONCE: leaving 'draft' means publish_exam() ran. It is the
-- only thing that sets published_at, and it does so only after exam_health()
-- reports no blocking issues. Requiring published_at on every non-draft row
-- therefore makes "was this validated?" checkable rather than assumed.
-- ═════════════════════════════════════════════════════════════════════════════

alter table public.exams drop constraint exams_published_has_paper;

alter table public.exams
  add constraint exams_published_has_paper check (
    status = 'draft'
    -- Every non-draft row was published, whatever its paper mode.
    or (
      published_at is not null
      and (
        -- A fixed exam froze a paper, so it must have one.
        (paper_mode = 'fixed' and question_count is not null and question_count > 0)
        -- A per_attempt exam freezes nothing; question_count records what the
        -- rules will draw, so it only has to be sane.
        or (paper_mode = 'per_attempt' and coalesce(question_count, 0) > 0)
      )
    )
  );

comment on constraint exams_published_has_paper on public.exams is
  'Leaving draft means publish_exam() ran: it is the only writer of published_at, and it writes it only after exam_health() reports no blocking issues. The previous version exempted per_attempt exams from every condition, letting one reach scheduled with no rules, no validation and no notifications — and 0016 then locked it permanently.';
