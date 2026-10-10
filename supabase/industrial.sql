-- ============================================================
-- BizPilot: team roles, safe concurrent saves, append-only audit log
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run),
-- AFTER schema.sql, marketing-media.sql and team-features.sql. Safe to re-run; data is kept.
--
-- What it adds (blueprint §6 B5, §12, §17, §19 Phase 1):
--   1. Staff roles: owner, manager, staff, viewer. Members see only their business.
--   2. Every saved record carries a row_version. Saves go through one database
--      transaction (bizpilot_commit) that refuses to overwrite a newer version,
--      so two people, the agent and a marketplace sync can't overwrite each other
--      or oversell stock. Either every change in a save lands, or none does.
--   3. The audit log can only be added to, never edited or deleted.
--   4. Only owners and managers can decide approvals; stock can't go negative.
--   5. Multi-location stock: shops, warehouses, transfers and stock counts.
--   6. Manufacturing: recipes (bill of materials) and production orders.
--   7. Quotations, payment reminders and repeating invoices.
--   8. Product variants and batch / expiry tracking.
--   9. Warehouse bins, pick and pack, staff tasks; receipts and branch costs; PDPA consent records and backups.
--  10. One login can own or join several businesses and switch between them; profile photos.
--  11. Orders imported from the owner's own website.
-- ============================================================

-- 0. Locations, transfers and stock counts (blueprint §3, A5, B4, B5) ------------------
create table if not exists locations (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  name text not null,
  type text default 'store' check (type in ('store','warehouse','online')),
  address text default '',
  is_default boolean default false,
  active boolean default true,
  created_at timestamptz default now(),
  unique (business_id, name)
);
create table if not exists stock_transfers (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  transfer_number text not null,
  from_location_id text not null,
  to_location_id text not null,
  lines jsonb not null default '[]'::jsonb,
  status text default 'draft' check (status in ('draft','in_transit','received','cancelled')),
  note text default '',
  created_at timestamptz default now(),
  shipped_at timestamptz,
  received_at timestamptz,
  created_by text default '',
  unique (business_id, transfer_number)
);
create table if not exists stock_counts (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  count_number text not null,
  location_id text default '',
  blind boolean default false,
  status text default 'open' check (status in ('open','submitted','approved','rejected','cancelled')),
  lines jsonb not null default '[]'::jsonb,
  note text default '',
  created_at timestamptz default now(),
  submitted_at timestamptz,
  decided_at timestamptz,
  created_by text default '',
  unique (business_id, count_number)
);
alter table products add column if not exists location_stock jsonb default '{}'::jsonb;
alter table stock_movements add column if not exists location_id text;
alter table stock_movements add column if not exists to_location_id text;
alter table sales_orders add column if not exists location_id text;
-- Orders read from the owner's own website (Settings → Integrations → Your own website)
alter table sales_orders drop constraint if exists sales_orders_source_check;
alter table sales_orders add constraint sales_orders_source_check check (source in ('manual','pos','shopee','lazada','tiktok_shop','website'));
alter table purchase_orders add column if not exists location_id text;
alter table stock_movements drop constraint if exists stock_movements_type_check;
alter table stock_movements add constraint stock_movements_type_check check (type in ('in','out','adjustment','transfer'));
create index if not exists idx_transfers_biz on stock_transfers (business_id, created_at desc);
create index if not exists idx_counts_biz on stock_counts (business_id, created_at desc);

-- Manufacturing (blueprint §5 A2) ---------------------------------------------------
alter table products add column if not exists bom jsonb default '[]'::jsonb;
alter table products add column if not exists labour_cost numeric(12,2) default 0;
alter table products add column if not exists overhead_cost numeric(12,2) default 0;
create table if not exists production_orders (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  order_number text not null,
  product_id text not null,
  quantity int not null check (quantity > 0),
  location_id text default '',
  status text default 'pending_approval' check (status in ('pending_approval','approved','in_progress','completed','cancelled')),
  materials jsonb not null default '[]'::jsonb,
  planned_unit_cost numeric(12,2) default 0,
  actual_unit_cost numeric(12,2) default 0,
  labour_cost numeric(12,2) default 0,
  overhead_cost numeric(12,2) default 0,
  good_qty int default 0,
  rejected_qty int default 0,
  batch_number text default '',
  qc_notes text default '',
  due_date text default '',
  note text default '',
  created_at timestamptz default now(),
  started_at timestamptz,
  completed_at timestamptz,
  created_by text default '',
  unique (business_id, order_number)
);
create index if not exists idx_production_biz on production_orders (business_id, created_at desc);

-- Quotations, payment reminders, repeating invoices (blueprint §8 D5) ----------------
create table if not exists quotations (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  quote_number text not null,
  customer_name text not null,
  customer_email text default '',
  customer_phone text default '',
  customer_address text default '',
  customer_tin text default '',
  customer_brn text default '',
  lines jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) default 0,
  tax_total numeric(12,2) default 0,
  total numeric(12,2) default 0,
  status text default 'draft' check (status in ('draft','sent','accepted','declined','expired','converted')),
  issued_date timestamptz default now(),
  valid_until timestamptz,
  payment_days int default 30,
  note text default '',
  invoice_id text,
  created_by text default '',
  unique (business_id, quote_number)
);
create index if not exists idx_quotations_biz on quotations (business_id, issued_date desc);
alter table invoices add column if not exists reminders_sent int default 0;
alter table invoices add column if not exists last_reminder_at timestamptz;
alter table invoices add column if not exists recurrence jsonb;
alter table invoices add column if not exists recurring_from text;
alter table invoices add column if not exists quotation_id text;

-- Variants and batches (blueprint §6 B1, §5 A5) ---------------------------------------
alter table products add column if not exists track_batches boolean default false;
alter table products add column if not exists batches jsonb default '[]'::jsonb;
alter table products add column if not exists parent_id text;
alter table products add column if not exists variant_options jsonb;
alter table stock_movements add column if not exists batch text;
create index if not exists idx_products_parent on products (business_id, parent_id);

-- Warehouse, finance extras, PDPA (blueprint §5 A3, §8 D, §17) -------------------------
alter table products add column if not exists bins jsonb;
alter table sales_orders add column if not exists pick_status text;
alter table sales_orders add column if not exists picked_at timestamptz;
alter table sales_orders add column if not exists packed_at timestamptz;
alter table sales_orders add column if not exists packed_by text;
alter table expenses add column if not exists receipt_url text;
alter table expenses add column if not exists location_id text;
create table if not exists staff_tasks (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  task_number text not null,
  title text not null,
  detail text default '',
  kind text default 'other' check (kind in ('pick','pack','put_away','count','receive','deliver','other')),
  assignee text default '',
  location_id text default '',
  ref text default '',
  due_date timestamptz,
  status text default 'open' check (status in ('open','in_progress','done','cancelled')),
  created_at timestamptz default now(),
  completed_at timestamptz,
  created_by text default '',
  done_by text default '',
  unique (business_id, task_number)
);
create table if not exists consents (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  customer_key text not null,
  customer_name text default '',
  email text default '',
  phone text default '',
  purpose text not null check (purpose in ('marketing','service')),
  channel text default 'any' check (channel in ('email','whatsapp','sms','any')),
  status text not null check (status in ('granted','withdrawn')),
  source text default '',
  note text default '',
  at timestamptz default now(),
  recorded_by text default ''
);
create index if not exists idx_tasks_biz on staff_tasks (business_id, created_at desc);
create index if not exists idx_consents_biz on consents (business_id, customer_key, at desc);

-- Receipts: private files, members of the business only (folder = business id).
insert into storage.buckets (id, name, public, file_size_limit)
values ('receipts', 'receipts', false, 10485760)
on conflict (id) do nothing;
drop policy if exists "receipts read" on storage.objects;
create policy "receipts read" on storage.objects for select to authenticated
  using (bucket_id = 'receipts' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists "receipts upload" on storage.objects;
create policy "receipts upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists "receipts delete" on storage.objects;
create policy "receipts delete" on storage.objects for delete to authenticated
  using (bucket_id = 'receipts' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
-- Daily backups: written and read by the BizPilot server only (no policies = no browser access).
insert into storage.buckets (id, name, public, file_size_limit)
values ('backups', 'backups', false, 52428800)
on conflict (id) do nothing;
-- Profile photos: public pictures, each person writes only their own folder (folder = their user id).
insert into storage.buckets (id, name, public, file_size_limit)
values ('avatars', 'avatars', true, 1048576)
on conflict (id) do nothing;
drop policy if exists "avatars upload" on storage.objects;
create policy "avatars upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "avatars delete" on storage.objects;
create policy "avatars delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- 1. Team members ------------------------------------------------------------------
create table if not exists business_members (
  id uuid primary key default gen_random_uuid(),
  business_id uuid not null references businesses (id) on delete cascade,
  user_id uuid references auth.users (id) on delete cascade,
  email text not null,
  role text not null default 'staff' check (role in ('manager','staff','viewer')),
  invited_by text default '',
  invited_at timestamptz default now(),
  accepted_at timestamptz,
  unique (business_id, email)
);
-- One login can own several businesses and be a member of several others (business switcher).
drop index if exists business_members_user_idx;
create unique index if not exists business_members_user_biz_idx on business_members (business_id, user_id) where user_id is not null;
create index if not exists business_members_user_lookup on business_members (user_id);
drop index if exists businesses_owner_idx;
create index if not exists businesses_owner_lookup on businesses (owner_id);

-- Two-step login (blueprint §17): a user who turned it on must have entered their
-- code in this session (token level aal2) before any business data is readable or writable.
create or replace function mfa_ok() returns boolean
language sql security definer stable set search_path = public, auth as $$
  select coalesce(auth.jwt() ->> 'aal', 'aal1') = 'aal2'
      or not exists (select 1 from auth.mfa_factors f where f.user_id = auth.uid() and f.status = 'verified');
$$;

-- The signed-in user's role in a business: owner, manager, staff, viewer or null.
create or replace function business_role(bid uuid) returns text
language sql security definer stable set search_path = public as $$
  select case
    when not mfa_ok() then null
    when exists (select 1 from businesses where id = bid and owner_id = auth.uid()) then 'owner'
    else (select role from business_members where business_id = bid and user_id = auth.uid())
  end;
$$;

-- Kept under its old name so every existing policy now means "any member of this business".
create or replace function is_business_owner(bid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select business_role(bid) is not null;
$$;

create or replace function can_write_business(bid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(business_role(bid) in ('owner','manager','staff'), false);
$$;

create or replace function can_manage_business(bid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select coalesce(business_role(bid) in ('owner','manager'), false);
$$;

-- Link the signed-in user to the business that invited their (confirmed) email address.
create or replace function accept_business_invite() returns uuid
language plpgsql security definer set search_path = public as $$
declare
  bid uuid;
begin
  if auth.uid() is null then return null; end if;
  -- Accept every pending invite for this (confirmed) email; a user can belong to several businesses.
  if exists (select 1 from auth.users where id = auth.uid() and email_confirmed_at is not null) then
    update business_members m set user_id = auth.uid(), accepted_at = now()
     where m.user_id is null and lower(m.email) = lower(auth.jwt() ->> 'email')
       and not exists (select 1 from business_members x where x.business_id = m.business_id and x.user_id = auth.uid())
       and not exists (select 1 from businesses b where b.id = m.business_id and b.owner_id = auth.uid());
  end if;
  select business_id into bid from business_members where user_id = auth.uid() order by accepted_at desc nulls last limit 1;
  return bid;
end $$;

grant execute on function business_role(uuid), is_business_owner(uuid), can_write_business(uuid),
  can_manage_business(uuid), accept_business_invite() to authenticated;

alter table business_members enable row level security;
drop policy if exists "members read team" on business_members;
create policy "members read team" on business_members for select using (is_business_owner(business_id));
drop policy if exists "owner manages team" on business_members;
create policy "owner manages team" on business_members for all
  using (business_role(business_id) = 'owner') with check (business_role(business_id) = 'owner');

-- Businesses: members read, owner/manager edit settings, only the owner creates or deletes.
drop policy if exists "own business" on businesses;
drop policy if exists "members read business" on businesses;
drop policy if exists "owner creates business" on businesses;
drop policy if exists "managers edit business" on businesses;
drop policy if exists "owner deletes business" on businesses;
create policy "members read business" on businesses for select using ((owner_id = auth.uid() and mfa_ok()) or is_business_owner(id));
create policy "owner creates business" on businesses for insert with check (owner_id = auth.uid());
create policy "managers edit business" on businesses for update using (can_manage_business(id)) with check (can_manage_business(id));
create policy "owner deletes business" on businesses for delete using (owner_id = auth.uid() and mfa_ok());

create or replace function guard_business_owner() returns trigger language plpgsql as $$
begin
  if new.owner_id is distinct from old.owner_id then raise exception 'The business owner cannot be changed here.'; end if;
  return new;
end $$;
drop trigger if exists guard_business_owner on businesses;
create trigger guard_business_owner before update on businesses for each row execute function guard_business_owner();

-- Business tables: members read; owner, manager and staff write; viewers read only.
do $$
declare t text;
begin
  foreach t in array array[
    'products','stock_movements','suppliers','purchase_orders','sales_orders','expenses',
    'invoices','reviews','support_tickets','campaigns','content_items','approval_requests',
    'audit_log','notifications','agent_tasks','return_cases','locations','stock_transfers','stock_counts','production_orders','quotations','staff_tasks','consents'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "tenant isolation" on %I', t);
    execute format('drop policy if exists "members read" on %I', t);
    execute format('drop policy if exists "members insert" on %I', t);
    execute format('drop policy if exists "members update" on %I', t);
    execute format('drop policy if exists "members delete" on %I', t);
    execute format('create policy "members read" on %I for select using (is_business_owner(business_id))', t);
    execute format('create policy "members insert" on %I for insert with check (can_write_business(business_id))', t);
    if t <> 'audit_log' then
      execute format('create policy "members update" on %I for update using (can_write_business(business_id)) with check (can_write_business(business_id))', t);
      execute format('create policy "members delete" on %I for delete using (can_write_business(business_id))', t);
    end if;
  end loop;
end $$;

-- 2. Row versions ---------------------------------------------------------------------
create or replace function bizpilot_bump_version() returns trigger language plpgsql as $$
begin
  new.row_version := coalesce(old.row_version, 0) + 1;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'businesses','products','stock_movements','suppliers','purchase_orders','sales_orders','expenses',
    'invoices','reviews','support_tickets','campaigns','content_items','approval_requests',
    'audit_log','notifications','agent_tasks','return_cases','locations','stock_transfers','stock_counts','production_orders','quotations','staff_tasks','consents'
  ]
  loop
    execute format('alter table %I add column if not exists row_version int not null default 0', t);
    execute format('drop trigger if exists bump_row_version on %I', t);
    execute format('create trigger bump_row_version before update on %I for each row execute function bizpilot_bump_version()', t);
  end loop;
end $$;


-- 3. Audit log is append-only ---------------------------------------------------------
create or replace function audit_log_append_only() returns trigger language plpgsql as $$
begin
  -- Deleting a whole business (or its owner's account) still removes its log.
  if tg_op = 'DELETE' and not exists (select 1 from businesses where id = old.business_id) then
    return old;
  end if;
  raise exception 'The audit log is append-only.';
end $$;
drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only before update or delete on audit_log
  for each row when (current_setting('bizpilot.allow_audit_purge', true) is distinct from 'on')
  execute function audit_log_append_only();

-- 4. Guards ---------------------------------------------------------------------------
create or replace function guard_approval_decision() returns trigger language plpgsql as $$
begin
  if auth.uid() is not null and new.status is distinct from old.status and not can_manage_business(new.business_id) then
    raise exception 'Only the owner or a manager can decide approvals.';
  end if;
  return new;
end $$;
drop trigger if exists guard_approval_decision on approval_requests;
create trigger guard_approval_decision before update on approval_requests for each row execute function guard_approval_decision();

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_stock_not_negative') then
    alter table products add constraint products_stock_not_negative
      check (stock >= 0 and reserved >= 0 and coalesce(unavailable, 0) >= 0) not valid;
  end if;
end $$;

-- The same marketplace or POS order can never be imported twice, even by two syncs at once.
do $$
begin
  create unique index if not exists sales_orders_external_uidx on sales_orders (business_id, source, external_id)
    where external_id is not null;
exception when unique_violation then
  raise notice 'Duplicate imported orders already exist, so the duplicate guard index was not created. Remove the duplicates and re-run.';
end $$;

-- 5. One-transaction, version-checked save ---------------------------------------------
-- p_changes: [{ "table": "products", "op": "upsert" | "delete" | "settings", "id": "...",
--               "version": 3 | null, "row": { ...snake_case columns... } }]
-- version null = new row (insert). A stale version raises SQLSTATE 40001 and nothing is saved.
create or replace function bizpilot_commit(p_business uuid, p_changes jsonb) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  allowed constant text[] := array[
    'products','stock_movements','suppliers','purchase_orders','sales_orders','expenses',
    'invoices','reviews','support_tickets','campaigns','content_items','approval_requests',
    'audit_log','notifications','agent_tasks','return_cases','locations','stock_transfers','stock_counts','production_orders','quotations','staff_tasks','consents'];
  c jsonb;
  tbl text;
  op text;
  rid text;
  ver int;
  newver int;
  rec jsonb;
  cols text;
  bad text;
  out jsonb := '[]'::jsonb;
begin
  -- Signed-in users (the web app) need write access; the BizPilot server (service role) has no auth.uid().
  if auth.uid() is not null and not can_write_business(p_business) then
    raise exception 'You do not have permission to change this business''s records.' using errcode = '42501';
  end if;
  for c in select value from jsonb_array_elements(p_changes) loop
    tbl := c ->> 'table';
    op := c ->> 'op';
    rid := c ->> 'id';
    ver := case when jsonb_typeof(c -> 'version') = 'number' then (c ->> 'version')::int else null end;

    if op = 'settings' then
      if auth.uid() is not null and not can_manage_business(p_business) then
        raise exception 'Only the owner or a manager can change business settings.' using errcode = '42501';
      end if;
      update businesses
         set name = coalesce(c -> 'row' ->> 'name', name),
             mode = coalesce(c -> 'row' ->> 'mode', mode),
             settings = coalesce(c -> 'row' -> 'settings', settings)
       where id = p_business and (ver is null or row_version = ver)
      returning row_version into newver;
      if newver is null then
        raise exception 'bizpilot_conflict: settings were changed by someone else' using errcode = '40001';
      end if;
      out := out || jsonb_build_object('table', 'businesses', 'id', p_business::text, 'version', newver);
      continue;
    end if;

    if not (tbl = any (allowed)) then
      raise exception 'bizpilot_commit: unknown table %', tbl;
    end if;

    if op = 'delete' then
      execute format('delete from %I where id = $1 and business_id = $2 and ($3::int is null or row_version = $3) returning 1', tbl)
        into newver using rid, p_business, ver;
      if newver is null and ver is not null then
        raise exception 'bizpilot_conflict: % % was changed by someone else', tbl, rid using errcode = '40001';
      end if;
      out := out || jsonb_build_object('table', tbl, 'id', rid, 'version', null);
      continue;
    end if;

    rec := (c -> 'row') - 'row_version' || jsonb_build_object('business_id', p_business, 'id', rid);
    select string_agg(k, ', ') into bad from jsonb_object_keys(rec) k
     where not exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = tbl and column_name = k);
    if bad is not null then
      raise exception 'Table % is missing columns: %. Run the latest SQL files in supabase/.', tbl, bad;
    end if;
    select string_agg(quote_ident(k), ', ') into cols from jsonb_object_keys(rec) k;

    if ver is null then
      execute format('insert into %1$I (%2$s) select %2$s from jsonb_populate_record(null::%1$I, $1) returning row_version', tbl, cols)
        into newver using rec;
    else
      execute format(
        'update %1$I set (%2$s) = (select %2$s from jsonb_populate_record(null::%1$I, $1)) '
        'where id = $2 and business_id = $3 and row_version = $4 returning row_version', tbl, cols)
        into newver using rec, rid, p_business, ver;
      if newver is null then
        raise exception 'bizpilot_conflict: % % was changed by someone else', tbl, rid using errcode = '40001';
      end if;
    end if;
    out := out || jsonb_build_object('table', tbl, 'id', rid, 'version', newver);
  end loop;
  return out;
end $$;

grant execute on function bizpilot_commit(uuid, jsonb) to authenticated, service_role;

-- Ask the API to pick up the new function and columns straight away.
notify pgrst, 'reload schema';
