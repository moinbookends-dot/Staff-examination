-- ═════════════════════════════════════════════════════════════════════════════
-- 0061 — A paper's working life: generated → live → retired.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THIS IS NOT ONLINE DELIVERY, AND THE DISTINCTION IS THE WHOLE POINT.      ║
-- ║                                                                           ║
-- ║ Candidates sit these papers ON PAPER. Nothing here opens a paper on a     ║
-- ║ screen, records an answer, or grades anything — the legacy attempt stack  ║
-- ║ does that for the old exam model and is deliberately untouched.           ║
-- ║                                                                           ║
-- ║ What a Chef lacked was a way to say WHICH generated paper is the one      ║
-- ║ currently in use. Twelve papers in the history list are all equally       ║
-- ║ printable and nothing distinguishes the one being sat this week. That is  ║
-- ║ the gap this closes, and it closes exactly that.                          ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═════════════════════════════════════════════════════════════════════════════

create type public.paper_status as enum ('generated', 'live', 'retired');

comment on type public.paper_status is
  'Where a printed paper is in its working life. generated = drawn but not yet in use; live = currently being sat; retired = finished with. Nothing to do with online delivery.';

alter table public.exam_papers
  add column status public.paper_status not null default 'generated',
  -- Who moved it and when. A paper going live is an operational decision
  -- somebody makes, and "who set this live" is the first question asked when a
  -- paper turns up in the wrong outlet.
  add column status_changed_at timestamptz,
  add column status_changed_by uuid references public.profiles(id) on delete set null;

-- "Which paper is live for this brand and level?" — the question the History
-- screen asks on every render, and the only one worth an index here.
create index exam_papers_live_idx
  on public.exam_papers (company_id, brand_id, difficulty, marks)
  where status = 'live';

-- ═════════════════════════════════════════════════════════════════════════════
-- The transition
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A FUNCTION RATHER THAN AN UPDATE POLICY, FOR A SPECIFIC REASON.           │
-- │                                                                           │
-- │ RLS chooses ROWS; it cannot say "this permission may write only this      │
-- │ column". An update policy permissive enough to let a Chef change `status` │
-- │ would also let them change paper_no, marks, combination_hash or epoch     │
-- │ straight over PostgREST — and combination_hash is the never-repeat rule.  │
-- │                                                                           │
-- │ 0056 gave these tables SELECT policies only and said the definer function │
-- │ is the whole write surface. This keeps that true: the only column any     │
-- │ caller can move is the one this function names.                           │
-- └───────────────────────────────────────────────────────────────────────────┘
create or replace function public.set_paper_status(
  p_paper_id uuid,
  p_status   public.paper_status
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_company uuid := public.my_company();
  v_current public.paper_status;
  v_no      int;
begin
  if not public.has_perm('papers.generate') then
    raise exception 'Not permitted to change a paper''s status.'
      using errcode = 'insufficient_privilege';
  end if;

  /*
   * The same visibility rule exam_papers_read applies, restated because this
   * function bypasses it. A caller who cannot see the paper is told it was not
   * found rather than refused, so this cannot be used to discover which paper
   * ids exist.
   */
  select p.status, p.paper_no into v_current, v_no
    from public.exam_papers p
   where p.id = p_paper_id
     and p.company_id = v_company
     and (p.brand_id = public.my_brand() or public.brand_unscoped());

  if v_current is null then
    raise exception 'That paper could not be found.'
      using errcode = 'no_data_found';
  end if;

  /*
   * 'generated' is the state a paper is BORN in, not one it can return to.
   * Allowing it back would erase the fact that a paper had once been issued —
   * and a paper that has been in a room with candidates is never again a paper
   * that has not.
   */
  if p_status = 'generated' then
    raise exception 'A paper cannot be returned to the generated state.'
      using errcode = 'check_violation';
  end if;

  -- Idempotent: setting live twice is not an error, it is the same request
  -- arriving twice, which is what a double-tapped button looks like.
  if v_current = p_status then
    return jsonb_build_object('status', p_status::text, 'paperNo', v_no, 'changed', false);
  end if;

  update public.exam_papers
     set status = p_status,
         status_changed_at = now(),
         status_changed_by = auth.uid()
   where id = p_paper_id;

  return jsonb_build_object('status', p_status::text, 'paperNo', v_no, 'changed', true);
end;
$$;

revoke execute on function public.set_paper_status(uuid, public.paper_status) from public, anon;
grant  execute on function public.set_paper_status(uuid, public.paper_status) to authenticated;

comment on function public.set_paper_status(uuid, public.paper_status) is
  'Moves a printed paper between generated/live/retired. SECURITY DEFINER because exam_papers has no UPDATE policy by design — an update policy could not stop a caller rewriting combination_hash, which is the never-repeat rule.';
