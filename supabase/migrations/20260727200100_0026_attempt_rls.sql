-- ═════════════════════════════════════════════════════════════════════════════
-- 0026 — RLS for attempts
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT A CANDIDATE MAY TOUCH, AND WHAT THEY MAY NOT.                        │
-- │                                                                           │
-- │ MAY:  their own attempt rows — to see that one exists, when it expires,   │
-- │       and afterwards what they scored.                                    │
-- │                                                                           │
-- │ MAY NOT (no policy at all, so RLS denies by default):                     │
-- │                                                                           │
-- │   attempt_questions  the paper. Read through attempt_paper() only, which  │
-- │                      checks the attempt is theirs. A select policy here   │
-- │                      would let them dump the paper straight from          │
-- │                      PostgREST, which is the thing 0015 refused to allow  │
-- │                      on exam_questions and would be no better here.       │
-- │                                                                           │
-- │   attempt_answers    their own answers, but writing them directly would   │
-- │                      bypass the deadline. Answers go through              │
-- │                      save_answer() (slice 2), which refuses past          │
-- │                      expires_at. A row-level policy cannot express "and   │
-- │                      the clock has not run out" without re-reading the    │
-- │                      parent on every write, and a candidate who could     │
-- │                      UPDATE directly would simply keep answering.         │
-- │                                                                           │
-- │ THE SCORE COLUMNS are readable on their own attempt. That is deliberate   │
-- │ and it is not a leak: score without the key tells them the total, not     │
-- │ which answers were right. M5 decides when results are RELEASED — until    │
-- │ then status is auto_graded or evaluating and no UI shows it.              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- WHY attempts CARRIES NO INSERT OR UPDATE POLICY FOR ANYBODY. start_attempt()
-- and (slice 2) save_answer/submit_attempt are SECURITY DEFINER and are the
-- only writers. Making the table unwritable from the application means the
-- attempt_number, the deadline and the frozen paper cannot be set by a client
-- that would very much like to choose them.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── attempts ─────────────────────────────────────────────────────────────────

create policy attempts_read_own on public.attempts
  for select to authenticated
  using (
    (select public.is_approved())
    and candidate_id = (select auth.uid())
  );

-- A chef sees their team's attempts; HR sees the company's. Both are read-only
-- here — evaluation writes through its own definer functions in slice 4.
create policy attempts_read_team on public.attempts
  for select to authenticated
  using (
    company_id = (select public.my_company())
    and (
      (select public.has_perm('attempts.read_all'))
      or (
        (select public.has_perm('attempts.read_team'))
        and exists (
          select 1 from public.profiles p
           where p.id = candidate_id
             and p.outlet_id = (select public.my_outlet())
        )
      )
    )
  );

-- ── attempt_questions ────────────────────────────────────────────────────────
-- No candidate policy, by design (see the header). Authors may read a paper for
-- evaluation and analytics.

create policy attempt_questions_read_staff on public.attempt_questions
  for select to authenticated
  using (
    exists (
      select 1 from public.attempts a
       where a.id = attempt_id
         and a.company_id = (select public.my_company())
         and (
           (select public.has_perm('attempts.read_all'))
           or (select public.has_perm('attempts.read_team'))
         )
    )
  );

-- ── attempt_answers ──────────────────────────────────────────────────────────
-- The candidate may READ their own answers — a resumed attempt has to show what
-- they already entered — but may not write them. attempt_paper() returns them
-- alongside the paper, and save_answer() is the only writer.

create policy attempt_answers_read_own on public.attempt_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.attempts a
       where a.id = attempt_id and a.candidate_id = (select auth.uid())
    )
  );

create policy attempt_answers_read_staff on public.attempt_answers
  for select to authenticated
  using (
    exists (
      select 1 from public.attempts a
       where a.id = attempt_id
         and a.company_id = (select public.my_company())
         and (
           (select public.has_perm('attempts.read_all'))
           or (select public.has_perm('attempts.read_team'))
           or (select public.has_perm('evaluation.evaluate'))
         )
    )
  );

comment on policy attempts_read_own on public.attempts is
  'A candidate reads their own attempts and nothing else. No insert or update policy exists for anyone: start_attempt() and save_answer() are SECURITY DEFINER and are the only writers, so a client cannot choose its own deadline, attempt number or paper.';
