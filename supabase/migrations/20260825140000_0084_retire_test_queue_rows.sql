-- ═══════════════════════════════════════════════════════════════════════════
-- 0084 — Finish what 0083 started, and stop it recurring.
--
-- ╔═══════════════════════════════════════════════════════════════════════════╗
-- ║ 0083 ABANDONED 1,312 ROWS AND LEFT 57. That was not a mistake in the      ║
-- ║ cutoff so much as a fact about it: 0083 draws its line at a fixed instant ║
-- ║ deliberately, so it is idempotent and cannot swallow genuinely new mail   ║
-- ║ on another environment. Rows enqueued after that instant survive by       ║
-- ║ design.                                                                   ║
-- ║                                                                           ║
-- ║ All 57 survivors were enqueued the same day by verification runs of this  ║
-- ║ project's own check scripts — 54 addressed to reserved domains that       ║
-- ║ cannot receive mail, and 3 to a real inbox with subjects reading          ║
-- ║ "Render check exam 1787645175126". Test artefacts, not notifications.     ║
-- ║                                                                           ║
-- ║ THE DURABLE FIX IS NOT THIS MIGRATION. It is isUndeliverable() in         ║
-- ║ src/lib/notifications/drain.ts, which refuses reserved domains before any ║
-- ║ provider call, so future check runs cannot queue doomed mail. This just   ║
-- ║ clears what is already there, so the first live drain starts from empty   ║
-- ║ rather than from somebody else's test data.                               ║
-- ╚═══════════════════════════════════════════════════════════════════════════╝
--
-- Same discipline as 0083: mark, never send, never delete. A fixed literal
-- cutoff again, for the same reason.
-- ═══════════════════════════════════════════════════════════════════════════

update public.email_outbox
   set failed_at  = now(),
       last_error = 'Abandoned by migration 0084: queued by a verification run before the '
                    'email drain existed. Not a real notification.'
 where sent_at    is null
   and failed_at  is null
   and created_at <  timestamptz '2026-08-25 12:00:00+00';

-- Belt and braces, and not bounded by date: an address on a reserved domain
-- can never receive mail, whenever it was queued. RFC 2606 reserves
-- example.com/net/org and the .test/.example/.invalid TLDs; .local is mDNS.
update public.email_outbox
   set failed_at  = now(),
       last_error = 'Unroutable address: reserved domain (RFC 2606 / mDNS .local). Never attempted.'
 where sent_at    is null
   and failed_at  is null
   and (
        to_email ilike '%@example.com'
     or to_email ilike '%@example.net'
     or to_email ilike '%@example.org'
     or to_email ilike '%.test'
     or to_email ilike '%.local'
     or to_email ilike '%.invalid'
   );
