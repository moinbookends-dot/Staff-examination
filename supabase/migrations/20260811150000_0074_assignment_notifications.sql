-- ═════════════════════════════════════════════════════════════════════════════
-- 0074 — Tell the candidate when a paper-backed exam is assigned to them.
--        Also retires the 50-mark paper size.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE NOTIFICATION MACHINERY ALREADY EXISTED. IT WAS WIRED TO THE OLD PATH. ║
-- ║                                                                           ║
-- ║ 0007 built `notifications`, 0014 taught publish_exam() to fill it from    ║
-- ║ exam_audience(), and 0023 made exam_audience() and is_exam_assigned_to_me ║
-- ║ share one rule so "who is notified" and "who can see it" cannot diverge.  ║
-- ║ All of that is good and none of it is rebuilt here.                       ║
-- ║                                                                           ║
-- ║ But publish_exam() is the LEGACY route. Papers are published by           ║
-- ║ publish_paper_as_exam() (0063/0064/0067), which mentions notifications,   ║
-- ║ email_outbox and exam_audience exactly zero times. Checked against the     ║
-- ║ live database rather than inferred: both paper-backed exams on this       ║
-- ║ project have 0 notifications between them.                                ║
-- ║                                                                           ║
-- ║ So a chef publishes a paper, RLS correctly shows it on the candidate's    ║
-- ║ /my-exams — and nothing whatsoever tells them it is there.                ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ A TRIGGER ON exam_assignments, NOT A CALL INSIDE publish_paper_as_exam.  │
-- │                                                                           │
-- │ Publishing does not assign anybody. publishPaperAsExam() writes the exam  │
-- │ and then calls setAssignments() as a SEPARATE, non-fatal step, and        │
-- │ assignments can be changed again at any time afterwards — the paper is    │
-- │ frozen at publish, the audience is not.                                   │
-- │                                                                           │
-- │ Putting the notification inside publish_paper_as_exam() would therefore   │
-- │ fire before anybody was assigned (notifying nobody) and never fire again  │
-- │ when somebody was added later. The row appearing in exam_assignments IS   │
-- │ the event, so that is what is watched. Every path that assigns — the      │
-- │ action, a script, a future bulk tool — is covered without knowing it.     │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═════════════════════════════════════════════════════════════════════════════

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. Notify everyone an exam now reaches who has not been told yet
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.notify_exam_audience(p_exam_id uuid)
returns int
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_exam    public.exams%rowtype;
  v_written int;
begin
  select * into v_exam from public.exams where id = p_exam_id and deleted_at is null;
  if not found then
    return 0;
  end if;

  /*
   * A DRAFT IS NOT AN ANNOUNCEMENT.
   *
   * Assignments can be attached to an exam before it is published. Telling
   * somebody about an exam they cannot yet open would be worse than silence:
   * they click, RLS refuses, and they learn to ignore the bell.
   *
   * 'cancelled' and 'closed' are excluded for the same reason in reverse —
   * there is nothing left to sit.
   */
  if v_exam.status not in ('scheduled', 'active') then
    return 0;
  end if;

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ IDEMPOTENT BY `NOT EXISTS`, NOT BY `ON CONFLICT`.                        │
   * │                                                                           │
   * │ 0014 used `on conflict do nothing`, which relies on a unique constraint   │
   * │ that `notifications` does not have — so it silently does nothing at all,  │
   * │ and re-running would duplicate. This project's notifications table shows  │
   * │ the result: 5,873 exam.assigned rows against 2,812 queued emails, because │
   * │ the same audience was told repeatedly.                                    │
   * │                                                                           │
   * │ Matching on (user, kind, exam id in data) means adding one person to an   │
   * │ outlet assignment notifies THAT person and nobody else a second time,     │
   * │ which is exactly what re-assigning should do.                             │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  insert into public.notifications (user_id, kind, title, body, link, data)
  select a.id,
         'exam.assigned',
         'You have a new exam',
         v_exam.title,
         -- /my-exams, NOT '/exams/' || id. The legacy path linked to an
         -- authoring route that was deleted in the consolidation; for a
         -- candidate the only screen that exists is their own list.
         '/my-exams',
         jsonb_build_object('exam_id', p_exam_id, 'title', v_exam.title)
    from public.exam_audience(p_exam_id) a
   where not exists (
     select 1 from public.notifications n
      where n.user_id = a.id
        and n.kind = 'exam.assigned'
        and n.data ->> 'exam_id' = p_exam_id::text
   );

  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

comment on function public.notify_exam_audience(uuid) is
  'Writes an in-app notification for everybody a published exam reaches who has not already been told about it. Idempotent, so re-assigning notifies only the people newly included. Silent for drafts, cancelled and closed exams — an announcement for something that cannot be opened teaches people to ignore the bell.';

revoke execute on function public.notify_exam_audience(uuid) from public, anon;
grant execute on function public.notify_exam_audience(uuid) to authenticated;

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. The event: a row appearing in exam_assignments
-- ═════════════════════════════════════════════════════════════════════════════

create or replace function public.on_exam_assignment_added()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  /*
   * Failure here must not fail the assignment.
   *
   * Somebody choosing an audience is doing the important thing; being told
   * about it is the secondary one. If notification raises — a constraint, a
   * permission, anything — the chef would see the assignment refused and would
   * have no idea why, because nothing on that screen is about notifications.
   * The assignment stands and the miss is recoverable; the reverse is not.
   */
  begin
    perform public.notify_exam_audience(new.exam_id);
  exception
    when others then
      raise warning 'notify_exam_audience failed for exam %: %', new.exam_id, sqlerrm;
  end;

  return new;
end;
$$;

drop trigger if exists exam_assignments_notify on public.exam_assignments;

create trigger exam_assignments_notify
  after insert on public.exam_assignments
  for each row
  execute function public.on_exam_assignment_added();

comment on function public.on_exam_assignment_added() is
  'Fires notify_exam_audience() when an exam gains an assignment. Watching the ASSIGNMENT rather than the publish is what makes this correct: publishing does not assign anybody, and the audience can change long after the paper is frozen.';

-- ═════════════════════════════════════════════════════════════════════════════
-- 3. Retire the 50-mark paper size
-- ═════════════════════════════════════════════════════════════════════════════

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DESTRUCTIVE, AND SAFE ONLY BECAUSE NOTHING USES IT.                      │
 * │                                                                           │
 * │ Checked before writing this: exam_papers holds four papers and every one  │
 * │ is 20 marks. No paper, no exam and no attempt references a 50-mark        │
 * │ blueprint, so this removes configuration for a size that was seeded and   │
 * │ never chosen.                                                             │
 * │                                                                           │
 * │ The row is deleted rather than flagged because paper_settings has no      │
 * │ "enabled" column and adding one to express "this size exists but may not  │
 * │ be used" would be a second source of truth against PAPER_SIZES in         │
 * │ src/lib/papers/blueprint.ts, which is what the generator actually reads.  │
 * │                                                                           │
 * │ ROLLBACK: re-run supabase/seed.sql — except that seed.sql no longer       │
 * │ carries the 50-mark row either, by the same decision. To bring it back,   │
 * │ restore both this row and PAPER_SIZES.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
do $$
declare
  v_used int;
begin
  select count(*) into v_used from public.exam_papers where marks = 50;
  if v_used > 0 then
    raise exception
      '0074: % paper(s) were generated at 50 marks — refusing to delete the blueprint they were built from', v_used;
  end if;
end;
$$;

delete from public.paper_settings where marks = 50;
