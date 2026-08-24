-- ═══════════════════════════════════════════════════════════════════════════
-- 0077 — Retire the "Prep" brand.
--
-- ┌───────────────────────────────────────────────────────────────────────────┐
-- │ TWO BRANDS, NOT THREE.                                                    │
-- │                                                                           │
-- │ The seed created Prep alongside Aiko and Capiche and nothing ever used   │
-- │ it: no questions, no papers, no exams, no import runs, nobody assigned   │
-- │ to its outlet. It only existed as a third entry in every brand picker —  │
-- │ one more way to import a file into the wrong bank.                       │
-- │                                                                           │
-- │ SOFT-DELETED, NOT DROPPED. brands_read (0005) hides a deleted brand from  │
-- │ every picker, bank_import_commit (0068) and brand_in_my_company() (0059) │
-- │ refuse it, and the id stays resolvable for anything historical. Reverse  │
-- │ with `set deleted_at = null` on both rows.                               │
-- │                                                                           │
-- │ THE GUARD IS THE POINT. Soft-deleting a brand that has since acquired    │
-- │ data would orphan it behind RLS — a question nobody can see and nobody   │
-- │ can draw. So this refuses to run unless Prep is still empty, and a       │
-- │ failing push says exactly what it found.                                 │
-- └───────────────────────────────────────────────────────────────────────────┘
-- ═══════════════════════════════════════════════════════════════════════════

do $$
declare
  v_brand  constant uuid := '00000000-0000-0000-0000-00000000b003';
  v_outlet constant uuid := '00000000-0000-0000-0000-00000000a003';
  v_n      int;
begin
  select count(*) into v_n from public.bank_questions where brand_id = v_brand;
  if v_n > 0 then
    raise exception '0077: Prep still holds % bank question(s); move them first.', v_n;
  end if;

  select count(*) into v_n from public.exam_papers where brand_id = v_brand;
  if v_n > 0 then
    raise exception '0077: Prep still holds % exam paper(s); retire them first.', v_n;
  end if;

  select count(*) into v_n from public.exams where brand_id = v_brand;
  if v_n > 0 then
    raise exception '0077: Prep still holds % exam(s); reassign them first.', v_n;
  end if;

  select count(*) into v_n
    from public.profiles
   where brand_id = v_brand or outlet_id = v_outlet;
  if v_n > 0 then
    raise exception '0077: % profile(s) still pinned to Prep; reassign them first.', v_n;
  end if;

  update public.outlets
     set deleted_at = now(), updated_at = now()
   where id = v_outlet and deleted_at is null;

  update public.brands
     set deleted_at = now(), updated_at = now()
   where id = v_brand and deleted_at is null;
end;
$$;
