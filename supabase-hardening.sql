-- ═══════════════════════════════════════════════════════════════
-- ROM Player by Coops — Supabase security hardening, ADDENDUM
-- Run this AFTER supabase-hardening.sql has already been applied.
-- Two fixes:
--   5. Atomic redeem — code-claim + premium-grant now happen in a
--      single transaction, so a mid-flight failure can never burn
--      a code without actually granting premium.
--   6. Extend protect_premium_columns to also fire on INSERT, for
--      full symmetry with the existing UPDATE protection (belt and
--      suspenders in the same spirit as the original comment).
-- ═══════════════════════════════════════════════════════════════


-- ───────────────────────────────────────────────────────────────
-- 5. Atomic redeem-and-grant, as a single SECURITY DEFINER function.
--    `for update` takes a row lock, so two concurrent redemptions
--    of the same code can never both succeed — the second one
--    blocks until the first commits, then sees used_by already set.
--    Runs as one implicit transaction: if anything after the lock
--    throws, Postgres rolls back the whole thing, so a code can
--    never end up "used" without profiles.is_premium actually
--    getting set.
-- ───────────────────────────────────────────────────────────────
create or replace function public.redeem_code(p_code_hash text, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
begin
  select id, used_by
    into v_row
    from redeem_codes
   where code_hash = p_code_hash
   for update;

  if not found then
    -- Same generic result as "already used by someone else" below —
    -- deliberately not distinguishable from the caller's side. See
    -- the _worker.js patch: both map to a single generic error.
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  if v_row.used_by is not null and v_row.used_by <> p_user_id then
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;

  if v_row.used_by is null then
    update redeem_codes
       set used_by = p_user_id, used_at = now()
     where id = v_row.id;
  end if;
  -- If used_by = p_user_id already (this same user re-submitting), we
  -- fall through and just re-grant premium — idempotent, matches the
  -- existing _worker.js behaviour.

  insert into profiles (id, is_premium, premium_source, updated_at)
  values (p_user_id, true, 'redeem', now())
  on conflict (id) do update
    set is_premium = true,
        premium_source = 'redeem',
        updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- Only the service role may ever call this — same posture as the
-- table-level locks on redeem_codes itself.
revoke all on function public.redeem_code(text, uuid) from public, anon, authenticated;
grant execute on function public.redeem_code(text, uuid) to service_role;


-- ───────────────────────────────────────────────────────────────
-- 6. Extend the existing premium-column trigger to also cover
--    INSERT. Column-level GRANTs already block this today (the
--    authenticated INSERT grant only includes id/user_prefs/
--    updated_at), so this is pure defense-in-depth matching the
--    original file's own stated philosophy for UPDATE — if a future
--    migration ever accidentally re-grants broader INSERT privileges,
--    this trigger still silently refuses to let premium columns be
--    set to anything but their safe defaults.
-- ───────────────────────────────────────────────────────────────
create or replace function public.protect_premium_columns()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.role() <> 'service_role' then
    if tg_op = 'INSERT' then
      new.is_premium := false;
      new.premium_source := null;
      if to_jsonb(new) ? 'stripe_customer_id' then
        new.stripe_customer_id := null;
      end if;
    else
      new.is_premium := old.is_premium;
      new.premium_source := old.premium_source;
      if to_jsonb(new) ? 'stripe_customer_id' then
        new.stripe_customer_id := old.stripe_customer_id;
      end if;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists protect_premium_columns_trg on public.profiles;
create trigger protect_premium_columns_trg
  before insert or update on public.profiles
  for each row
  execute function public.protect_premium_columns();


-- ───────────────────────────────────────────────────────────────
-- 7. Sanity checks — run after applying, both should return rows
--    confirming the function exists and only service_role can run it.
-- ───────────────────────────────────────────────────────────────
-- select proname, prosecdef from pg_proc where proname = 'redeem_code';
-- select grantee, privilege_type from information_schema.role_routine_grants
--  where routine_name = 'redeem_code';
