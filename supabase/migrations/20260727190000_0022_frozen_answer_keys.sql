-- ═════════════════════════════════════════════════════════════════════════════
-- 0022 — Grading reads the key that was SERVED, not the key that is current
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE HOLE THIS CLOSES, BEFORE M4 CAN FALL INTO IT.                         │
-- │                                                                           │
-- │ exam_questions freezes a question's CONTENT — stem, options — and the     │
-- │ revision it was frozen at. It does not freeze the ANSWER KEY, which lives │
-- │ in question_answer_keys and is mutable for as long as the question is.    │
-- │                                                                           │
-- │ So the obvious implementation of M4 —                                     │
-- │                                                                           │
-- │     select answer_key from question_answer_keys where question_id = …     │
-- │                                                                           │
-- │ — grades a candidate against a key that may have changed since they sat   │
-- │ the paper. A chef corrects a wrong answer on Tuesday; every attempt from  │
-- │ Monday is now marked against a truth that did not exist when it was       │
-- │ taken. Nothing errors. The marks are simply wrong, and there is no        │
-- │ record that they ever differed.                                           │
-- │                                                                           │
-- │ 0011 already bumps questions.revision when a key changes, and 0012        │
-- │ already stores answer_key PER REVISION in question_revisions. Everything  │
-- │ needed was present; nothing connected it to grading.                      │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ M4 OBLIGATION — THE INVARIANT.                                            │
-- │                                                                           │
-- │ Grading MUST obtain keys through answer_key_at_revision(question_id,      │
-- │ revision), passing the revision recorded on the row the candidate was     │
-- │ actually served — exam_questions.question_revision for a fixed paper,     │
-- │ attempt_questions.question_revision for a per-attempt one.                │
-- │                                                                           │
-- │ It MUST NOT read public.question_answer_keys. That table is the AUTHORING │
-- │ surface: what the key is now. Grading needs what the key was.             │
-- │                                                                           │
-- │ tests/integration/exam-draw.test.ts pins the difference — after a key is   │
-- │ edited the two sources disagree, and the test asserts which one an        │
-- │ attempt is entitled to. If M4 wires the wrong source, that test fails.    │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.answer_key_at_revision(
  p_question_id uuid,
  p_revision    int
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_key jsonb;
  v_found boolean;
begin
  select r.answer_key, true
    into v_key, v_found
    from public.question_revisions r
   where r.question_id = p_question_id
     and r.revision    = p_revision;

  -- RAISES rather than returning null, deliberately. A null key silently
  -- grades every candidate as wrong; an exception stops the attempt being
  -- graded at all and is noticed. Publication is supposed to make this
  -- unreachable — exam_health's key.missing check refuses to publish a paper
  -- whose questions cannot be graded — so reaching here means an invariant
  -- broke and should be loud.
  if not coalesce(v_found, false) then
    raise exception
      'no revision % recorded for question % — cannot grade an answer against a paper that was never captured',
      p_revision, p_question_id
      using errcode = 'P0002';
  end if;

  if v_key is null then
    raise exception
      'revision % of question % was captured without an answer key',
      p_revision, p_question_id
      using errcode = 'P0002';
  end if;

  return v_key;
end;
$$;

-- INTERNAL. Granted to nobody: it returns answer keys, and the only legitimate
-- caller is M4's grader, which is itself a SECURITY DEFINER function. Reachable
-- by `authenticated` this would be the leak that 0009's whole two-table design
-- exists to prevent — see migration 0020 for what "revoke from public" alone
-- does not achieve.
revoke all on function public.answer_key_at_revision(uuid, int)
  from public, anon, authenticated;

comment on function public.answer_key_at_revision(uuid, int) is
  'The ONLY sanctioned source of an answer key for grading. Returns the key captured with that exact revision, so an attempt is always marked against the paper it was served rather than against whatever the question says now. INTERNAL: granted to nobody. M4 must not read question_answer_keys — that is the authoring surface.';

-- ── exam_health gains a blocking check ───────────────────────────────────────
--
-- A paper that cannot be graded must not be publishable. This makes
-- answer_key_at_revision's exception unreachable in practice, which is what
-- lets it be an exception rather than a silent null.
create or replace function public.exam_health(p_exam_id uuid)
returns table (
  code       text,
  severity   text,
  section_id uuid,
  rule_id    uuid,
  message    text,
  detail     jsonb
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exam record;
begin
  select * into v_exam from public.exams e
   where e.id = p_exam_id and e.deleted_at is null
     and e.company_id = public.my_company();

  if v_exam is null then
    raise exception 'exam not found' using errcode = '42501';
  end if;
  if not public.has_perm('exams.update') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with drawn as (
    select * from public.draw_paper(p_exam_id, p_exam_id::text)
  ),
  drawn_q as (
    select d.*, q.type, q.difficulty, q.estimated_seconds, q.stem
      from drawn d join public.questions q on q.id = d.question_id
  ),
  audience_locales as (
    select distinct a.preferred_locale as locale
      from public.exam_audience(p_exam_id) a
     where a.preferred_locale <> 'en'
  )

  select 'structure.no_sections'::text, 'blocking'::text, null::uuid, null::uuid,
         'This exam has no sections, so there is nothing to draw.'::text,
         '{}'::jsonb
   where not exists (select 1 from public.exam_sections s where s.exam_id = p_exam_id)

  union all
  select 'structure.no_rules', 'blocking', s.id, null::uuid,
         format('Section "%s" has no selection rules.', s.title),
         '{}'::jsonb
    from public.exam_sections s
   where s.exam_id = p_exam_id
     and not exists (select 1 from public.exam_rules r where r.section_id = s.id)

  union all
  select 'rule.short', 'blocking', r.section_id, r.id,
         format('Rule asked for %s question(s); the bank could supply %s.',
                r.question_count, coalesce(d.drawn, 0)),
         jsonb_build_object('requested', r.question_count,
                            'drawn', coalesce(d.drawn, 0),
                            'missing', r.question_count - coalesce(d.drawn, 0))
    from public.exam_rules r
    join public.exam_sections s on s.id = r.section_id and s.exam_id = p_exam_id
    left join (select dr.rule_id, count(*)::int as drawn from drawn dr group by dr.rule_id) d
           on d.rule_id = r.id
   where coalesce(d.drawn, 0) < r.question_count

  union all
  select 'paper.duplicate', 'blocking', null::uuid, null::uuid,
         'The same question was drawn more than once.',
         jsonb_build_object('question_id', dr.question_id)
    from drawn dr
   group by dr.question_id
  having count(*) > 1

  union all
  select 'marks.zero', 'blocking', null::uuid, null::uuid,
         'The paper totals zero marks.',
         jsonb_build_object('total_marks', coalesce((select sum(marks) from drawn), 0))
   where coalesce((select sum(marks) from drawn), 0) <= 0

  union all
  select 'media.missing', 'blocking', dq.section_id, dq.rule_id,
         format('A %s question has no media attached, so it cannot be answered.', dq.type),
         jsonb_build_object('question_id', dq.question_id, 'stem', left(dq.stem, 120))
    from drawn_q dq
   where dq.type in ('image', 'video', 'audio', 'document')
     and not exists (select 1 from public.question_media m where m.question_id = dq.question_id)

  -- ── NEW: the paper must be gradable ───────────────────────────────────────
  -- Without a key captured at the revision being frozen, an attempt cannot be
  -- marked against what the candidate was actually shown. Blocking, because the
  -- alternative is discovering it after people have sat the exam.
  union all
  select 'key.missing', 'blocking', dq.section_id, dq.rule_id,
         format('No answer key was captured for revision %s of this question, so it cannot be graded.',
                dq.question_revision),
         jsonb_build_object('question_id', dq.question_id,
                            'revision', dq.question_revision,
                            'stem', left(dq.stem, 120))
    from drawn_q dq
   where not exists (
     select 1 from public.question_revisions r
      where r.question_id = dq.question_id
        and r.revision    = dq.question_revision
        and r.answer_key is not null
   )

  union all
  select 'difficulty.narrow', 'advisory', null::uuid, null::uuid,
         'Every question on this paper is the same difficulty.',
         jsonb_build_object('difficulty', min(dq.difficulty))
    from drawn_q dq
  having count(distinct dq.difficulty) = 1 and count(*) > 1

  union all
  select 'duration.mismatch', 'advisory', null::uuid, null::uuid,
         format('About %s minutes of questions against a %s minute limit.',
                round(sum(dq.estimated_seconds) / 60.0), v_exam.duration_minutes),
         jsonb_build_object('estimated_minutes', round(sum(dq.estimated_seconds) / 60.0),
                            'duration_minutes', v_exam.duration_minutes)
    from drawn_q dq
   where dq.estimated_seconds is not null
  having count(*) > 0
     and (sum(dq.estimated_seconds) > v_exam.duration_minutes * 60 * 1.4
       or sum(dq.estimated_seconds) < v_exam.duration_minutes * 60 * 0.6)

  union all
  select 'translation.missing', 'advisory', null::uuid, null::uuid,
         format('%s question(s) have no published %s translation.', count(*), al.locale),
         jsonb_build_object('locale', al.locale, 'question_count', count(*))
    from drawn dr
    cross join audience_locales al
   where not exists (
     select 1 from public.question_translations t
      where t.question_id = dr.question_id
        and t.locale = al.locale
        and t.status = 'published'
   )
   group by al.locale;

  return;
end;
$$;

grant execute on function public.exam_health(uuid) to authenticated;
