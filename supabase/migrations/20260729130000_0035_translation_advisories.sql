-- ═════════════════════════════════════════════════════════════════════════════
-- 0035 — Telling a chef what translation will not do for them
--
-- M7 introduced three failures that are silent by construction. Each is a
-- consequence of a decision taken deliberately, and each would otherwise be
-- discovered by a candidate reading the wrong thing or being marked wrong.
--
--   translation.stale          The English was reworded after a translation was
--                              published. The Hindi now describes text that no
--                              longer exists, and it is delivered with MORE
--                              confidence than the English, because it looks
--                              like a finished translation.
--
--   translation.accepts_stale  Per-language accepted answers were added after
--                              the exam was published. Writing them bumps
--                              questions.revision (0011), exam_questions froze
--                              the revision at publish, and answer_key_at_
--                              revision therefore returns the old key. A
--                              Gujarati candidate types the Gujarati answer and
--                              is marked wrong. Nothing else reports it.
--
--   translation.section_title  exam_sections.title has no translation
--                              mechanism, so a fully-Gujarati paper still
--                              carries English section headings.
--
-- All three are ADVISORY. None is a reason to block a publish: a chef may
-- legitimately run an exam whose translations lag, and turning that into a
-- blocking check would teach people to translate carelessly just to get past
-- the gate.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THE WHOLE FUNCTION IS REPRODUCED.                                     │
-- │                                                                           │
-- │ exam_health is one statement — a CTE feeding a chain of UNION ALL         │
-- │ branches — so a branch cannot be appended without restating it. Every     │
-- │ branch below the new ones is 0022's, unchanged. The alternative, a second │
-- │ function returning "the other advisories", would split "is this exam      │
-- │ healthy?" across two places, and the UI would have to remember to ask     │
-- │ both.                                                                     │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════
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
   group by al.locale

  -- ── 0035 ──────────────────────────────────────────────────────────────────

  -- A published translation of wording that has since changed. Worse than no
  -- translation: it reads as finished, so nobody looks at it again.
  union all
  select 'translation.stale', 'advisory', null::uuid, null::uuid,
         format('%s %s translation(s) were written before the question was last reworded.',
                count(*), t.locale),
         jsonb_build_object('locale', t.locale, 'question_count', count(*))
    from drawn dr
    join public.questions q on q.id = dr.question_id
    join public.question_translations t
      on t.question_id = dr.question_id
     and t.status = 'published'
     and t.base_revision < q.revision
   group by t.locale

  -- Accepts added after this exam was published. exam_questions froze the
  -- revision, so answer_key_at_revision returns the key as it stood then — the
  -- new accepted answers are not in it, and a candidate answering in that
  -- language is marked wrong with nothing to show why.
  --
  -- Deliberately NOT solved by retro-editing question_revisions: that table is
  -- append-only by design, and "the frozen thing is behind, re-publish" is how
  -- every other version gap in this codebase is handled.
  union all
  select 'translation.accepts_stale', 'advisory', null::uuid, null::uuid,
         format('%s question(s) gained accepted answers in another language after this exam was published. Re-publish to include them.',
                count(*)),
         jsonb_build_object('question_count', count(*))
    from public.exam_questions eq
    join public.questions q on q.id = eq.question_id
    join public.question_answer_keys k on k.question_id = eq.question_id
   where eq.exam_id = p_exam_id
     and eq.question_revision < q.revision
     and (k.answer_key ->> 'format') = 'blanks'
     and exists (
       select 1 from jsonb_array_elements(k.answer_key -> 'blanks') b
        where b ? 'acceptByLocale'
     )
  having count(*) > 0

  -- Section headings have no translation mechanism at all. Named here rather
  -- than half-solved with a title_i18n column, which would be a SECOND
  -- translation system with different rules from question_translations.
  union all
  select 'translation.section_title', 'advisory', null::uuid, null::uuid,
         format('Section headings are shown in English to %s reader(s); they cannot be translated yet.',
                al.locale),
         jsonb_build_object('locale', al.locale)
    from audience_locales al
   where exists (
     select 1 from public.exam_sections s
      where s.exam_id = p_exam_id and coalesce(btrim(s.title), '') <> ''
     having count(*) > 1
   );

  return;
end;
$$;

grant execute on function public.exam_health(uuid) to authenticated;

comment on function public.exam_health(uuid) is
  'Everything wrong with an exam, blocking first. 0035 added three translation advisories, all advisory rather than blocking: a chef may legitimately run an exam whose translations lag, and blocking would teach people to translate carelessly to get past the gate.';
