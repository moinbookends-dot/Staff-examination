-- ═════════════════════════════════════════════════════════════════════════════
-- 0036 — Telling somebody where they stand without telling them about anybody
--        else
--
-- A candidate holds reports.read_own and nothing more. They cannot call
-- team_stats() — it raises for scope 'own' — and they must not be able to, since
-- its RETURNS TABLE carries full_name. But "am I doing well?" is a question with
-- no answer in this system unless it is answered relative to somebody.
--
-- This returns the caller's own position and nothing that identifies anyone
-- else: a rank, a percentile, a population count. No names, no scores but the
-- caller's own, and no parameter — see below.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHY THERE IS NO p_candidate_id, AND WHY THERE NEVER WILL BE.              │
-- │                                                                           │
-- │ candidate_stats(p_candidate_id) exists and is guarded: it raises unless   │
-- │ the caller is asking about themselves or holds team scope. A second       │
-- │ function that took a candidate id would be a second route to the same     │
-- │ data, and the two would have to be kept in step forever. This one takes   │
-- │ no arguments and reads auth.uid(). There is nothing to guard because      │
-- │ there is nothing to ask for.                                             │
-- │                                                                           │
-- │ The same argument rules out a p_exam_id. Two per-exam slices of a cohort  │
-- │ that differ by one person identify that person; a filterable leaderboard  │
-- │ is a differencing oracle wearing a dropdown.                              │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE COHORT IS THE COMPANY, NOT THE OUTLET. THIS IS THE PRIVACY DECISION.  │
-- │                                                                           │
-- │ An outlet cohort is a kitchen brigade. The candidate can enumerate it by  │
-- │ walking into the room — they do not need users.read_team to know who is   │
-- │ in it, which is why the absence of that permission protects them less     │
-- │ than it appears to.                                                       │
-- │                                                                           │
-- │ Rank is the most disclosive statistic there is about an ordering: "3rd    │
-- │ of 4" is not an aggregate, it is the exact statement that two named       │
-- │ people scored above me and one below. At a cohort of two it is a          │
-- │ complete disclosure about one identified colleague, every time, with no   │
-- │ uncertainty at all.                                                      │
-- │                                                                           │
-- │ Company scope makes the cohort larger and, more importantly, not          │
-- │ enumerable by the person reading it.                                     │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ THE FLOOR IS TEN, AND IT IS THE SAME TEN.                                 │
-- │                                                                           │
-- │ 0030 withholds a question's discrimination below ten responses, on the    │
-- │ grounds that "a wrong number that looks plausible is worse than no        │
-- │ number". Here the reasoning inverts and gets stronger: a rank of 3 of 4   │
-- │ is CORRECT, and its correctness is the harm. This is the one place in     │
-- │ the schema where a number being right is what makes it dangerous.         │
-- │                                                                           │
-- │ So the floor is disclosure control rather than quality control — but it   │
-- │ is the same constant, spelled the same way, because two "too few to       │
-- │ report" thresholds in one schema is how one of them quietly becomes 3.    │
-- │                                                                           │
-- │ Below it, rank, percentile AND cohort_n are all NULL. Not just the rank:  │
-- │ a bare population count polled over time is a publication tracker, where  │
-- │ every increment marks the day one identified person's first result was    │
-- │ released.                                                                │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ WHAT THIS DOES NOT SOLVE, RECORDED SO NOBODY BELIEVES OTHERWISE.          │
-- │                                                                           │
-- │ The floor closes the small-cohort disclosure. It does NOT close temporal  │
-- │ differencing: a candidate's own score is a probe they control, and their  │
-- │ rank as a function of it is the cohort's distribution sampled point by    │
-- │ point. Someone who sits exams deliberately and watches their rank move    │
-- │ can narrow other people's scores into intervals. That works at a cohort   │
-- │ of forty as well as at four — it is slower, not harder.                   │
-- │                                                                           │
-- │ Closing it needs a coarse band instead of an integer rank, or a           │
-- │ period-closed snapshot instead of live rows. Both are product decisions.  │
-- │ "We added a minimum of ten" solved half the problem, and the half it did  │
-- │ not solve is written here rather than in nobody's head.                   │
-- └───────────────────────────────────────────────────────────────────────────┘
--
-- PUBLISHED ONLY, DIVERGING FROM analytics_attempts ON PURPOSE.
-- That view admits auto_graded, evaluated and verified, because a chef's report
-- should reflect marking that has happened. A candidate must not see their own
-- mark before release — 0029's my_results() masks score, percent and passed
-- until status = 'published' — and a rank computed from a held attempt would
-- move the moment it was marked, which discloses the mark by inference. So the
-- cohort here joins back to attempts and takes only published rows. The
-- consequence is that this figure and /reports will legitimately disagree; that
-- is the correct disagreement, and it is why it is written down.
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.my_standing()
returns table (
  best_percent   numeric,
  cohort_n       int,
  rank_position  int,
  percentile     int,
  suppressed     boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- Same constant, same name, same reasoning as 0030's discrimination floor.
  c_min_n constant int := 10;
  v_me    numeric;
  v_n     int;
  v_rank  int;
begin
  if not public.has_perm('reports.read_own') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- One query, three answers. The cohort is built, sized and ranked in a
  -- single pass and then the caller's own row is picked out of it — so the
  -- rank the caller is told is by construction the rank they hold in the
  -- population they are being counted against. Computing the count and the
  -- position separately is how those two drift apart under concurrency.
  --
  -- rank(), not dense_rank(): ties share a position and stay invisible.
  -- dense_rank() counts DISTINCT scores above the caller, which is a sharper
  -- claim — it would let them detect ties among the people above them.
  select s.best, s.n, s.pos
    into v_me, v_n, v_rank
    from (
      select c.candidate_id,
             c.best,
             count(*) over ()::int                   as n,
             rank() over (order by c.best desc)::int as pos
        from (
          select aa.candidate_id, max(aa.percent) as best
            from public.analytics_attempts aa
            -- The join that makes this candidate-safe. analytics_attempts does
            -- not project status, so the release gate comes from the table.
            join public.attempts a
              on a.id = aa.attempt_id
             and a.status = 'published'
           where aa.company_id = public.my_company()
             and aa.percent is not null
           group by aa.candidate_id
        ) c
    ) s
   where s.candidate_id = auth.uid();

  -- Somebody with nothing published has no standing. Without this the count
  -- below is `where best_percent > NULL` = 0, hence rank 1 — the system would
  -- tell a person who has sat nothing that they are top of the company. That
  -- is exactly the "plausible wrong number" 0030's header warns about.
  if v_me is null then
    return query select null::numeric, null::int, null::int, null::int, false;
    return;
  end if;

  if v_n < c_min_n then
    -- The cohort itself is withheld, not just the position within it.
    return query select v_me, null::int, null::int, null::int, true;
    return;
  end if;

  return query
  select v_me,
         v_n,
         v_rank,
         -- Share of the cohort at or below the caller. n > 1 is guaranteed
         -- here by the floor, so the division is safe.
         round(100.0 * (v_n - v_rank) / (v_n - 1))::int,
         false;
end;
$$;

grant execute on function public.my_standing() to authenticated;

comment on function public.my_standing() is
  'Where the caller stands among their company, and nothing about anybody else. No parameter, so there is nothing to ask for on another person''s behalf; company-scoped rather than outlet-scoped because an outlet cohort is a room the reader can count; published attempts only, so a held mark cannot be inferred from a rank that moved; and rank, percentile and cohort size are all withheld below ten participants, because at small n a rank is an exact statement about named colleagues. Does not defend against a candidate who moves their own score and watches their rank — see the migration header.';
