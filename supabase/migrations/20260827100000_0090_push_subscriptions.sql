-- ═══════════════════════════════════════════════════════════════════════════
-- 0090 — Web Push: the notification that reaches a phone with the app closed.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ THE IN-APP BELL ONLY WORKS ON SOMEBODY ALREADY IN THE APP. An exam        ║
-- ║ assignment lands, a row appears in `notifications`, and a cook who has    ║
-- ║ not opened Performix that day learns nothing until they do. Web Push is   ║
-- ║ the missing half: the browser's push service delivers to the OS shade     ║
-- ║ even while the app is closed.                                             ║
-- ║                                                                           ║
-- ║ TWO PIECES OF STATE, BOTH HERE:                                           ║
-- ║                                                                           ║
-- ║  push_subscriptions — one row per (user, browser install). The endpoint   ║
-- ║    URL plus two keys IS the capability to notify that device; treated     ║
-- ║    with the same secrecy as an email address, and then some.              ║
-- ║                                                                           ║
-- ║  notifications.pushed_at — the drain's high-water mark, on the existing   ║
-- ║    notifications table so push can NEVER disagree with the bell about     ║
-- ║    what was said. One source of truth, two delivery surfaces.             ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
-- ═══════════════════════════════════════════════════════════════════════════

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,

  -- The browser-issued push endpoint. Unique: re-subscribing the same browser
  -- must update the row, not accumulate dead siblings.
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,

  user_agent text,
  created_at timestamptz not null default now(),
  -- Stamped on every successful send; lets a later sweep retire dead rows.
  last_ok_at timestamptz,
  -- Counted up on provider rejections (404/410 = gone); the sender deletes
  -- rows the push service says are dead, so this only records flakiness.
  failures   int not null default 0
);

create index push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;

-- Supabase's default grants gave anon and authenticated every column; narrow
-- them the way 0081 narrowed outlets. anon gets nothing at all.
revoke all on public.push_subscriptions from anon;

/*
 * A person manages THEIR OWN device subscriptions and nobody else's. There is
 * deliberately no policy letting anyone read another user's endpoints — an
 * endpoint is the capability to put words on somebody's lock screen. The
 * sending job reads with the service key, which RLS does not bind.
 */
create policy push_subscriptions_own on public.push_subscriptions
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

comment on table public.push_subscriptions is
  'Web Push endpoints, one per (user, browser install). Owner-only under RLS; the push drain reads them with the service key. Endpoint + keys are the capability to notify that device — never client-readable across users.';

-- ── The high-water mark ──────────────────────────────────────────────────────

alter table public.notifications
  add column if not exists pushed_at timestamptz;

-- The drain's queue: unpushed, newest last. Partial, so the index stays the
-- size of the backlog rather than the size of history.
create index if not exists notifications_unpushed_idx
  on public.notifications (created_at)
  where pushed_at is null;

/*
 * Everything already sitting in notifications predates push entirely. Marking
 * it pushed (without pushing) mirrors 0083's email decision exactly: the first
 * drain must not dump a month of stale "you have a new exam" onto lock
 * screens. Fixed literal cutoff, same reasoning as 0083.
 */
update public.notifications
   set pushed_at = now()
 where pushed_at is null
   and created_at < timestamptz '2026-08-27 00:00:00+00';
