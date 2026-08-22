-- ═════════════════════════════════════════════════════════════════════════════
-- 0046 — Exam health learns what the attempt data already knew
--
-- exam_health has always checked whether a paper can be DRAWN and GRADED. It
-- has never checked whether the questions on it are any good, even though the
-- statistics to say so have existed since 0030.
--
-- Four advisories, all reading public.question_quality() (0044) rather than
-- recomputing anything. That function is the single definition of what makes a
-- question weak; the bank's health column and the quality dashboard read the
-- same one, so a question flagged here is flagged identically everywhere else.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THE WHOLE FUNCTION IS REPRODUCED, AGAIN.                              │
-- │                                                                           │
-- │ exam_health is one statement — a CTE feeding a chain of UNION ALL         │
-- │ branches — so a branch cannot be appended without restating it. 0035 said │
-- │ the same thing and gave the same reason.                                  │
-- │                                                                           │
-- │ Every line below except two marked substitutions is 0035's, EXTRACTED     │
-- │ FROM THAT FILE rather than retyped. Retyping a function from memory is    │
-- │ how 0039 silently lost a set_config call, and this one is four times the  │
-- │ length. The two changes are: drawn_q now also carries bloom_level, and    │
-- │ four branches are appended before the closing semicolon.                  │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- All four are ADVISORY. A chef may knowingly run a paper containing an ugly
-- question, and blocking on a statistic would teach people to retire questions
-- to get past the gate — 0035's argument, applied to a different signal.
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
    select d.*, q.type, q.difficulty, q.estimated_seconds, q.stem, q.bloom_level
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
   )

  -- ── 0046: what the statistics say about the questions on this paper ────────
  --
  -- All ADVISORY, for the same reason 0035's are: a chef may knowingly run a
  -- paper containing a question whose numbers are ugly, and blocking on a
  -- statistic would teach people to retire questions to get past the gate.
  --
  -- Every branch reads public.question_quality (0044) rather than recomputing
  -- facility or discrimination. That function is the only definition of what
  -- makes a question weak, and the bank's health column and the quality
  -- dashboard read the same one — so a question flagged on this screen is
  -- flagged identically everywhere else.
  --
  -- WHAT IS DELIBERATELY ABSENT: an advisory for "unproven" questions. On a
  -- young bank every question is unproven, so it would fire on every paper
  -- from the first exam until enough attempts accumulate — an advisory that is
  -- always on is one people learn to scroll past, taking the real ones with it.
  -- The dashboard reports coverage, which is where that number belongs.
  --
  -- ALSO ABSENT: distractor analysis. question_distractors is per-question and
  -- reads every settled answer; running it for each drawn MCQ would make
  -- publishing an exam pay for a report nobody asked for at that moment. It
  -- stays an inspection tool.

  union all
  select 'quality.negative_discrimination', 'advisory', null::uuid, null::uuid,
         format('%s question(s) on this paper are answered correctly MORE often by candidates who score badly overall. That usually means the key is wrong.',
                count(*)),
         jsonb_build_object('question_count', count(*),
                            'question_ids', jsonb_agg(qq.question_id))
    from drawn dr
    join public.question_quality() qq on qq.question_id = dr.question_id
   where qq.verdict = 'negative_discrimination'
  having count(*) > 0

  union all
  select 'quality.misrated', 'advisory', null::uuid, null::uuid,
         format('%s question(s) are rated at least two difficulty bands away from how candidates actually perform on them.',
                count(*)),
         jsonb_build_object('question_count', count(*),
                            'question_ids', jsonb_agg(qq.question_id))
    from drawn dr
    join public.question_quality() qq on qq.question_id = dr.question_id
   where qq.verdict = 'misrated'
  having count(*) > 0

  union all
  select 'quality.non_discriminating', 'advisory', null::uuid, null::uuid,
         format('%s question(s) barely distinguish strong candidates from weak ones.', count(*)),
         jsonb_build_object('question_count', count(*),
                            'question_ids', jsonb_agg(qq.question_id))
    from drawn dr
    join public.question_quality() qq on qq.question_id = dr.question_id
   where qq.verdict = 'non_discriminating'
  having count(*) > 0

  -- Bloom, not difficulty — difficulty.narrow above already covers that axis.
  -- Fires only where the levels are actually SET: a paper drawn from a bank
  -- with no Bloom levels at all is bank.no_bloom's complaint, and reporting it
  -- twice in different words helps nobody.
  union all
  select 'quality.bloom_narrow', 'advisory', null::uuid, null::uuid,
         format('Every question on this paper sits at one cognitive level (%s), so it tests recall or reasoning but not both.',
                min(dq.bloom_level)),
         jsonb_build_object('bloom_level', min(dq.bloom_level))
    from drawn_q dq
   where dq.bloom_level is not null
  having count(distinct dq.bloom_level) = 1 and count(*) > 1;

  return;
end;
$$;

grant execute on function public.exam_health(uuid) to authenticated;

comment on function public.exam_health(uuid) is
  'Everything wrong with an exam, blocking first. 0046 added four statistical advisories that read question_quality() rather than recomputing facility or discrimination, so the paper screen, the bank and the quality dashboard cannot disagree about which questions are weak. No "unproven" advisory: on a young bank it would fire on every paper ever drawn, and an advisory that is always on is one people learn to scroll past.';
