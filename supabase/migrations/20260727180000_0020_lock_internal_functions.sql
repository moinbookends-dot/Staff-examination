-- ═════════════════════════════════════════════════════════════════════════════
-- 0020 — SECURITY FIX: internal helper functions were reachable by anon
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT WAS WRONG                                                            │
-- │                                                                           │
-- │ 0014 and 0018 protected four SECURITY DEFINER helpers with                │
-- │                                                                           │
-- │     revoke all on function … from public;                                 │
-- │                                                                           │
-- │ REVOKE … FROM PUBLIC removes only the PUBLIC pseudo-role's ACL entry. It  │
-- │ does not touch an explicit grant held by a named role. This project's     │
-- │ database auto-grants EXECUTE on new functions to `anon` and               │
-- │ `authenticated`, so after the revoke the ACL still read                   │
-- │                                                                           │
-- │     anon=X/postgres | authenticated=X/postgres                            │
-- │                                                                           │
-- │ and every one of them stayed callable through PostgREST.                  │
-- │                                                                           │
-- │ CONFIRMED BY EXPLOIT, not by reading. With nothing but the publishable    │
-- │ key that ships in every browser bundle, and NO SESSION AT ALL:            │
-- │                                                                           │
-- │   POST /rest/v1/rpc/draw_paper        → 200, the whole paper in order     │
-- │   POST /rest/v1/rpc/question_snapshot → 200, stem and every option        │
-- │   POST /rest/v1/rpc/exam_audience     → 200, every assignee's EMAIL       │
-- │   POST /rest/v1/rpc/question_pool     → 200, enumerate the question bank  │
-- │                                                                           │
-- │ publish_exam() seeds the draw with the exam id, so passing that id as the │
-- │ seed reproduces the exact frozen paper — a candidate could read the real  │
-- │ paper before the timer started. exam_audience additionally leaked staff   │
-- │ email addresses to the open internet.                                     │
-- │                                                                           │
-- │ Every other definer function was already safe: exam_health, exam_paper,   │
-- │ publish_exam, duplicate_exam, exam_rule_counts, preview_rule_count,       │
-- │ get_question_revision, me_status and is_exam_assigned_to_me all carry an  │
-- │ internal has_perm/my_company/auth.uid() check, and                        │
-- │ custom_access_token_hook is granted to nobody. The four below were the    │
-- │ only ones relying on the ACL alone.                                       │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- WHY THESE FOUR CANNOT SIMPLY GAIN AN INTERNAL has_perm() CHECK INSTEAD.
--
-- They are building blocks for callers with different rights. draw_paper() and
-- question_snapshot() must work for a CANDIDATE when M4 draws a per-attempt
-- paper at attempt start — a candidate holds no exams.* permission at all, so
-- any has_perm() gate inside them would break the very path they exist to
-- serve. Their guard is therefore the ACL, and the ACL has to actually be right.
--
-- The rule for anything added later: a SECURITY DEFINER function is either
-- granted to `authenticated` AND carries its own permission check, or it is
-- granted to nobody and is reached only from another definer function. There is
-- no third option, and "revoke from public" is not one of them.
-- ═════════════════════════════════════════════════════════════════════════════

revoke all on function public.question_snapshot(uuid)
  from public, anon, authenticated;

revoke all on function public.draw_paper(uuid, text)
  from public, anon, authenticated;

revoke all on function public.exam_audience(uuid)
  from public, anon, authenticated;

revoke all on function public.question_pool(
  uuid, uuid, boolean, uuid[], public.question_type[], smallint, smallint
) from public, anon, authenticated;

-- ── Assert it, rather than trusting that the revoke did what we meant ────────
--
-- The revoke above is exactly the kind of statement that looks right and does
-- nothing, which is how the original bug survived review. This block fails the
-- migration if any of the four is still reachable, so a future change that
-- re-grants them — a blanket `grant execute on all functions`, for instance —
-- cannot land quietly.
do $$
declare
  v_leaky text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', ')
    into v_leaky
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('question_snapshot', 'draw_paper', 'exam_audience', 'question_pool')
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  if v_leaky is not null then
    raise exception
      'internal helpers still reachable by anon/authenticated: %. See the header of migration 0020.',
      v_leaky;
  end if;
end;
$$;

comment on function public.question_snapshot(uuid) is
  'Builds the candidate-visible payload — stem, content, media — with an explicit column list, never reading question_answer_keys or question_revisions. INTERNAL: granted to nobody, reached only from another SECURITY DEFINER function. It has no permission check of its own because M4 must call it for a candidate, who holds no exams.* permission.';
comment on function public.draw_paper(uuid, text) is
  'The single rule resolver, shared by publish and (in M4) attempt start. INTERNAL: granted to nobody. Callable directly it would hand over a whole paper — publish_exam seeds with the exam id, so the seed is guessable and the draw reproducible.';
comment on function public.exam_audience(uuid) is
  'Who an exam reaches, with their email. INTERNAL: granted to nobody — this returns personal data and has no permission check of its own.';
