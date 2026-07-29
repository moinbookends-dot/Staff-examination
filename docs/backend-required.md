# Backend required

Panels that exist in the design and cannot yet be filled with true numbers.

Each one is rendered by `<BackendRequired>` — it keeps its place in the layout,
says plainly that it is waiting on the database, and names what it is waiting
for. None of them is filled with plausible-looking data. The dashboard's
original docblock set that rule and it still holds:

> a dashboard showing invented data is worse than one showing less

Every figure that *is* on the dashboard today is computed from a live query. The
list below is what is missing, why it is missing, and exactly what would close
it.

---

## The rule these all have to satisfy

**`analytics_attempts` (migration 0030) is the single definition of "which
attempts count":** status in `auto_graded | evaluated | verified | published`,
on an exam flagged `counts_towards_analytics`, not soft-deleted.

Any new aggregate must be built on that view and not on `public.attempts`
directly. Counting the table instead silently includes practice papers, voided
attempts and in-flight ones, and the new panel then disagrees with `/reports`
about the same number. The view's own comment names the failure:

> two copies of which attempts count is how two reports quietly disagree about
> the same number

Every function below must also satisfy the two checks already in CI:

- **`tests/integration/function-acl.test.ts`** — a `SECURITY DEFINER` function is
  either granted to `authenticated` **and** carries its own permission check, or
  granted to nobody. There is no third option, and a general assertion enforces
  it for functions nobody remembered to add to a list.
- **`.github/workflows/ci.yml` job `types`** — `scripts/gen-types.mjs` is re-run
  against the replayed schema and diffed against the committed
  `src/lib/db/database.types.ts`. New SQL without regenerated types fails CI.

---

## 1 — Weekly engagement

**Panel:** the bar chart, centre of the Stitch Executive Overview.
**Shows:** attempts started and completed per week, split by training vs
assessment.

**Why it is blocked.** Nothing exposes time-bucketed attempt counts.
`analytics_attempts` has no date bucketing, `attempts.started_at` is not
returned by any RPC, and `my_attempts()` / `my_results()` are self-only. A
client-side rollup is impossible because the rows never reach the client.

```sql
create or replace function public.engagement_by_week(p_weeks int default 12)
returns table (
  week_start date,
  kind       public.exam_kind,
  started    int,
  completed  int
)
language sql
stable
security definer
set search_path = public
as $$
  -- has_perm() first: see function-acl.test.ts. Scope with analytics_scope()
  -- exactly as team_stats() does, so a chef sees their team and HR sees all.
  select date_trunc('week', a.started_at)::date,
         e.kind,
         count(*)::int,
         count(*) filter (where a.submitted_at is not null)::int
    from public.analytics_attempts a
    join public.exams e on e.id = a.exam_id
   where public.has_perm('reports.read_team') or public.has_perm('reports.read_all')
     and a.started_at >= now() - make_interval(weeks => p_weeks)
   group by 1, 2
   order by 1;
$$;

grant execute on function public.engagement_by_week(int) to authenticated;
```

**Also needed:** `started_at` is not currently a column on `analytics_attempts`
— check and add it to the view, which is a change to 0030's definition.

**Effort:** ~half a day including the view change, types regeneration and an
integration test asserting the scope.

---

## 2 — Trend deltas

**Panel:** the `+10.8%` / `-3%` chips on the Stitch stat rail, and the
"over last week" line under the hero pass rate.

**Why it is blocked.** Every analytics RPC returns a single all-time figure.
There is no period parameter anywhere, so there is nothing to compare against.

Two options, in order of preference:

1. **Add a period to the existing functions** — `candidate_stats(p_from, p_to)`,
   `team_stats(p_from, p_to)`, `exam_stats(p_exam_id, p_from, p_to)`. Callers
   pass two windows and the delta is computed in TypeScript. Keeps one
   definition of every figure.
2. A dedicated `stats_delta(p_window interval)`. Faster to write, but it is a
   second place that decides what "average score" means, which is the failure
   mode §0 warns about.

**Prefer option 1.** It also unlocks the date-range selector in the Stitch page
header, which is omitted today for the same reason — a filter control that does
not filter is worse than no control.

**Effort:** ~1 day. Touches four functions and every caller.

---

## 3 — Performance by department

**Panel:** the horizontal bar list, bottom-left of the Stitch Executive
Overview.

**Why it is blocked.** `team_stats()` returns `outlet_id` and nothing else
organisational — no `department_id`, and no display name for either. So the
rollup cannot be done client-side, and the labels would not exist even if it
could.

```sql
create or replace function public.department_stats()
returns table (
  department_id   uuid,
  department_name text,
  outlet_id       uuid,
  outlet_name     text,
  candidates_n    int,
  attempts_n      int,
  passed_n        int,
  pass_rate       numeric,   -- NULL when attempts_n = 0, never 0
  avg_percent     numeric    -- NULL when attempts_n = 0, never 0
)
...
```

**NULL is not zero,** and CI enforces it: `tests/integration/analytics.test.ts`
pins *"reports no attempts as no rate, not as a zero rate"* and *"lists a
candidate who has sat nothing rather than omitting them"*. A department nobody
has sat anything in must come back with a null rate and still appear.

**Substituted in the meantime.** The dashboard renders **performance by exam**
from `exam_stats()` in that slot — real data, weakest first, answering the
adjacent question ("which paper is the team struggling with"). It is not a
placeholder for the department rollup; it is a different, working panel.

**Effort:** ~half a day.

---

## 4 — Live activity — BLOCKED ON RLS, NOT ON A QUERY

**Panel:** the activity feed, bottom-right of the Stitch Executive Overview.
**Shows:** who approved whom, who changed a role, who published an exam.

**The table already exists and is already indexed.** `public.audit_logs`
(migration 0006) has `audit_logs_actor_idx` and `audit_logs_occurred_idx`, is
append-only, and is the only source in the system for those questions.

**Do not build this panel until the policy is fixed.**

```sql
-- migration 0006, as it stands:
create policy audit_logs_read on public.audit_logs
  for select to authenticated
  using ((select public.has_perm('audit.read')));
```

There is **no `company_id` predicate**. Any holder of `audit.read` can read every
company's audit trail. Rendering a feed from it would not create the hole — the
hole is already there — but it would be the first thing to actually expose it,
turning a latent policy bug into a live cross-tenant leak on the landing page.

**Required first:**

```sql
drop policy audit_logs_read on public.audit_logs;

create policy audit_logs_read on public.audit_logs
  for select to authenticated
  using (
        (select public.has_perm('audit.read'))
    and company_id = (select public.my_company())
  );
```

Then confirm `audit_logs` has `company_id` populated on every write path in
`audit_row()`; if it does not, that is the real first task, and back-filling it
is part of this work.

This should be fixed **whether or not the panel is ever built**. It is
independent of the dashboard.

**Effort:** ~half a day for the policy, back-fill and a multi-tenant RLS test
proving company B cannot read company A's trail. Then ~half a day for the feed.

---

## 5 — Not built, and not placeheld

Two Stitch controls are absent rather than stubbed, because a control that does
not work is worse than one that is not there:

- **Date-range selector** (page header). No RPC accepts a range — see §2. It
  arrives free with option 1 there.
- **Outlet switcher** (top bar). The `app` claim carries a single `outlet_id`
  baked at token mint. Switching outlet is not a UI affordance, it is a change
  to the claims model and to `custom_access_token_hook`. Out of scope for a
  redesign.
