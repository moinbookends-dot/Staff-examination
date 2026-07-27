-- ═════════════════════════════════════════════════════════════════════════════
-- 0007 — In-app notifications + email outbox
--
-- WHY THE OUTBOX EXISTS FROM DAY ONE (plan §10)
--
-- Resend's free tier allows 100 emails/day. Publishing results for 300 staff is
-- a single action that would generate 300 emails — three times the daily quota,
-- in one click. Separately, Supabase's built-in auth SMTP is rate-limited to
-- roughly 2–4 emails per HOUR and is explicitly not for production, so custom
-- SMTP is mandatory and draws from that same 100/day.
--
-- The outbox makes this survivable: nothing is ever dropped, only delayed. A
-- drain job sends the highest-priority, oldest-first messages up to a daily
-- cap and leaves the rest queued.
--
-- The table exists in M1 — before any feature needs it — specifically so that
-- features write to the queue rather than calling Resend directly. Once one
-- feature calls the provider inline, the quota ceiling stops being enforceable
-- anywhere.
--
-- In-app notifications are the PRIMARY channel: free, unlimited, and this
-- workforce is in the app anyway. Email is the exception, not the default.
-- ═════════════════════════════════════════════════════════════════════════════

-- ── notifications ────────────────────────────────────────────────────────────
create table public.notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,

  kind        text not null,   -- registration.approved | exam.assigned | …
  title       text not null,
  body        text,
  link        text,            -- in-app destination, e.g. /exams/<id>

  -- Rendering payload. Titles/bodies are stored resolved rather than as
  -- translation keys because a notification must remain readable exactly as it
  -- was sent, even if the user later switches language or the copy changes.
  data        jsonb not null default '{}'::jsonb,

  read_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- The bell-icon query: my unread, newest first.
create index notifications_unread_idx on public.notifications (user_id, created_at desc)
  where read_at is null;
create index notifications_user_idx on public.notifications (user_id, created_at desc);

-- ── email_outbox ─────────────────────────────────────────────────────────────
create table public.email_outbox (
  id            uuid primary key default gen_random_uuid(),

  to_email      text not null,
  to_user_id    uuid references public.profiles(id) on delete set null,
  subject       text not null,
  template      text not null,                    -- template id in src/lib/notifications/templates
  payload       jsonb not null default '{}'::jsonb,

  -- 1 = highest. The drain sends in priority then age order, so a password
  -- reset never queues behind 300 results notifications.
  --   1 password reset · 2 registration decision · 3 results published
  --   4 exam assigned  · 5 digest
  priority      smallint not null default 5 check (priority between 1 and 9),

  scheduled_for timestamptz not null default now(),  -- digests target 08:00 IST
  sent_at       timestamptz,
  failed_at     timestamptz,
  attempts      smallint not null default 0,
  last_error    text,

  created_at    timestamptz not null default now()
);

-- The drain query: unsent, due, not exhausted — priority then age.
create index email_outbox_queue_idx
  on public.email_outbox (priority, scheduled_for)
  where sent_at is null and attempts < 5;

create index email_outbox_user_idx on public.email_outbox (to_user_id);

-- Guards against a retry storm re-sending the same message. A caller supplying
-- a stable dedupe key gets at-most-once delivery for free.
create unique index email_outbox_dedupe_idx
  on public.email_outbox ((payload ->> 'dedupe_key'))
  where payload ? 'dedupe_key' and sent_at is null;

-- ── RLS ──────────────────────────────────────────────────────────────────────
alter table public.notifications enable row level security;
alter table public.email_outbox  enable row level security;

-- Users read only their own notifications. No approval gate: a rejected user
-- must still be able to read the notification explaining why.
create policy notifications_self_read on public.notifications
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Marking as read is the only user-facing mutation. Column restriction is
-- enforced in the server action; RLS scopes the row.
create policy notifications_self_update on public.notifications
  for update to authenticated
  using      (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- No insert policy. Notifications are written server-side only — either by the
-- admin client or by SECURITY DEFINER functions. If users could insert their
-- own, a notification would stop being trustworthy evidence of a system event.

-- email_outbox gets NO policy at all beyond RLS being enabled: it is entirely
-- server-side. Enabled + no policy = deny all, which is exactly right. It
-- contains other people's email addresses and must never be client-readable.

comment on table public.email_outbox is
  'Queue, not a send log. Features enqueue here; a drain job sends within the free-tier daily cap, priority then age. Never call the email provider inline — that is how a 300-recipient action blows the quota.';
comment on table public.notifications is
  'Primary notification channel. Free and unlimited, unlike email. Server-written only: no insert policy exists.';
