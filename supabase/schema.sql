-- ============================================================
-- BizPilot — Supabase schema v2
-- Run this whole file in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).
-- Safe to re-run. Every business table carries business_id and is protected by
-- Row Level Security, so one business can never read another business's data.
--
-- Column names are the snake_case form of the fields in src/lib/db/types.ts;
-- src/lib/db/remote.ts maps between the two automatically.
-- ============================================================

-- 0. Remove tables from older BizPilot versions ---------------------------
-- If any BizPilot table exists but is missing a column this version needs,
-- all BizPilot tables are dropped and recreated (older versions held no real data).
do $$
declare
  needs_reset boolean := false;
  r record;
begin
  for r in select * from (values
    ('businesses','settings'), ('businesses','owner_id'), ('products','channel_skus'), ('stock_movements','actor'),
    ('suppliers','notes'), ('purchase_orders','lines'), ('sales_orders','date'), ('sales_orders','shipment'),
    ('expenses','paid'), ('invoices','einvoice'), ('reviews','external_id'), ('support_tickets','body'),
    ('content_items','image_url'), ('campaigns','daily_cap'), ('approval_requests','execution_status'),
    ('audit_log','entity_id'), ('notifications','read'), ('integrations','provider_id'),
    ('agent_tasks','events'), ('api_tokens','token_hash')
  ) as t(tbl, col) loop
    if exists (select 1 from information_schema.tables where table_schema = 'public' and table_name = r.tbl)
       and not exists (select 1 from information_schema.columns
                       where table_schema = 'public' and table_name = r.tbl and column_name = r.col) then
      needs_reset := true;
    end if;
  end loop;
  if needs_reset or exists (select 1 from information_schema.tables
                            where table_schema = 'public' and table_name in ('purchase_order_lines','sales_order_lines')) then
    raise notice 'Old BizPilot tables found: dropping and recreating them.';
    drop table if exists purchase_order_lines, sales_order_lines, api_tokens, agent_tasks, integrations, notifications,
      audit_log, approval_requests, content_items, campaigns, support_tickets, reviews, invoices, expenses,
      sales_orders, purchase_orders, stock_movements, products, suppliers, businesses cascade;
  end if;
end $$;

-- 1. Business workspaces ------------------------------------------------------
create table if not exists businesses (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  mode text not null default 'hybrid' check (mode in ('online','retail','hybrid')),
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz default now()
);
create index if not exists businesses_owner_lookup on businesses (owner_id); -- one owner can have several businesses

-- helper: is the signed-in user the owner of this business?
create or replace function is_business_owner(bid uuid) returns boolean
language sql security definer stable set search_path = public as $$
  select exists (select 1 from businesses where id = bid and owner_id = auth.uid());
$$;

-- 2. Catalogue & inventory -------------------------------------------------------
create table if not exists products (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  sku text not null,
  name text not null,
  category text default '',
  description text default '',
  barcode text default '',
  supplier_id text,
  unit_cost numeric(12,2) default 0,
  price numeric(12,2) default 0,
  weight_kg numeric(8,3) default 0.5,
  stock int default 0,
  reserved int default 0,
  unavailable int default 0,
  incoming int default 0,
  reorder_level int default 0,
  safety_stock int default 0,
  max_stock int default 0,
  order_multiple int default 1,
  expiry_date text default '',
  avg_daily_sales numeric(10,3) default 0,
  status text default 'active' check (status in ('active','discontinued','seasonal','draft')),
  channel_skus jsonb default '{}'::jsonb,
  unique (business_id, sku)
);

create table if not exists stock_movements (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  product_id text not null,
  type text not null check (type in ('in','out','adjustment')),
  quantity int not null,
  reason text default '',
  reference text default '',
  date timestamptz default now(),
  actor text default ''
);

-- 3. Supply chain ------------------------------------------------------------------
create table if not exists suppliers (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  name text not null,
  contact_person text default '',
  email text default '',
  phone text default '',
  categories jsonb default '[]'::jsonb,
  unit_cost numeric(12,2) default 0,
  min_order_qty int default 0,
  lead_time_days int default 7,
  payment_terms text default '',
  reliability_score int default 0,
  on_time_rate numeric(5,4) default 0,
  defect_rate numeric(5,4) default 0,
  notes text default ''
);

create table if not exists purchase_orders (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  po_number text not null,
  supplier_id text,
  lines jsonb not null default '[]'::jsonb,
  status text default 'draft' check (status in
    ('draft','pending_approval','approved','ordered','partially_received','received','cancelled')),
  total_cost numeric(12,2) default 0,
  expected_date timestamptz,
  created_at timestamptz default now(),
  received_at timestamptz,
  sent_at timestamptz,
  note text default '',
  unique (business_id, po_number)
);

-- 4. Sales & finance -----------------------------------------------------------------
create table if not exists sales_orders (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  order_number text not null,
  channel text default 'online' check (channel in ('online','retail')),
  source text default 'manual' check (source in ('manual','pos','shopee','lazada','tiktok_shop','website')),
  external_id text,
  customer_name text default '',
  customer_email text default '',
  customer_phone text default '',
  shipping_address text default '',
  shipping_postcode text default '',
  lines jsonb not null default '[]'::jsonb,
  total numeric(12,2) default 0,
  status text default 'awaiting_fulfilment' check (status in ('awaiting_fulfilment','fulfilled','cancelled')),
  payment_status text default 'pending' check (payment_status in ('paid','pending','refunded')),
  payment_method text default '',
  date timestamptz default now(),
  shipment jsonb,
  invoice_id text,
  unique (business_id, order_number)
);
-- an imported marketplace order can only exist once per business
create unique index if not exists sales_orders_external_idx
  on sales_orders (business_id, source, external_id) where external_id is not null;

create table if not exists expenses (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  category text not null,
  description text default '',
  amount numeric(12,2) not null,
  date timestamptz default now(),
  recurring boolean default false,
  due_date timestamptz,
  paid boolean default true
);

create table if not exists invoices (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  invoice_number text not null,
  type text default 'invoice' check (type in ('invoice','credit_note','consolidated')),
  customer_name text default '',
  customer_email text default '',
  customer_tin text default '',
  customer_brn text default '',
  customer_phone text default '',
  customer_address text default '',
  lines jsonb not null default '[]'::jsonb,
  subtotal numeric(12,2) default 0,
  tax_total numeric(12,2) default 0,
  total numeric(12,2) default 0,
  status text default 'draft' check (status in ('draft','issued','paid','overdue','cancelled')),
  issued_date timestamptz,
  due_date timestamptz,
  paid_date timestamptz,
  order_id text,
  einvoice jsonb not null default '{"status":"not_submitted"}'::jsonb,
  unique (business_id, invoice_number)
);

-- 5. Customer experience ------------------------------------------------------------
create table if not exists reviews (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  source text default 'manual',
  external_id text,
  product_id text,
  customer_name text default '',
  rating int check (rating between 1 and 5),
  text text default '',
  sentiment text default 'neutral' check (sentiment in ('positive','neutral','negative')),
  topic text default 'other',
  status text default 'new' check (status in ('new','responded','escalated')),
  date timestamptz default now(),
  draft_response text,
  posted_response text
);
create unique index if not exists reviews_external_idx
  on reviews (business_id, source, external_id) where external_id is not null;

create table if not exists support_tickets (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  subject text not null,
  customer_name text default '',
  customer_email text default '',
  body text default '',
  priority text default 'medium' check (priority in ('low','medium','high')),
  status text default 'open' check (status in ('open','in_progress','resolved')),
  created_at timestamptz default now(),
  resolved_at timestamptz,
  notes text default ''
);

-- 6. Marketing ----------------------------------------------------------------------
create table if not exists campaigns (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  name text not null,
  objective text default 'sales',
  platform text default '',
  budget numeric(12,2) default 0,
  daily_cap numeric(12,2) default 0,
  spend numeric(12,2) default 0,
  clicks int default 0,
  impressions int default 0,
  conversions int default 0,
  revenue numeric(12,2) default 0,
  status text default 'draft' check (status in ('draft','active','paused','ended')),
  start_date timestamptz,
  end_date timestamptz,
  external_id text
);

create table if not exists content_items (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  title text not null,
  platform text default 'Facebook',
  type text default 'post',
  body text default '',
  image_url text default '',
  status text default 'draft' check (status in ('draft','in_review','approved','scheduled','published','failed')),
  scheduled_date timestamptz,
  campaign_id text,
  external_post_id text,
  published_at timestamptz,
  error text
);

-- 7. Governance -----------------------------------------------------------------------
create table if not exists approval_requests (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  type text not null,
  title text not null,
  description text default '',
  payload jsonb default '{}'::jsonb,
  amount numeric(12,2),
  risk text default 'medium' check (risk in ('low','medium','high')),
  status text default 'pending' check (status in ('pending','approved','rejected')),
  execution_status text,
  execution_result text,
  requested_by text default 'BizPilot AI',
  created_at timestamptz default now(),
  decided_at timestamptz,
  decided_by text
);

create table if not exists audit_log (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  actor text default '',
  action text not null,
  entity text default '',
  entity_id text default '',
  details text default '',
  at timestamptz default now()
);

create table if not exists notifications (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  title text not null,
  body text default '',
  severity text default 'info' check (severity in ('info','warning','critical')),
  at timestamptz default now(),
  read boolean default false
);

-- 8. WorkBuddy agent tasks (one row per goal given to the agent) ------------------
create table if not exists agent_tasks (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  prompt text not null,
  mode text default 'local',
  status text default 'starting',
  workbuddy_task_id text,
  workbuddy_link text,
  events jsonb not null default '[]'::jsonb,
  result text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
-- Command Centre chats: every message in one chat shares a conversation_id.
alter table agent_tasks add column if not exists conversation_id text;
create index if not exists idx_agent_tasks_conv on agent_tasks (business_id, conversation_id, created_at);

-- 9. External integrations (credentials are only readable by the server's service role)
create table if not exists integrations (
  business_id uuid not null references businesses (id) on delete cascade,
  provider_id text not null,
  credentials jsonb default '{}'::jsonb,
  tokens jsonb default '{}'::jsonb,
  status text default 'unconfigured'
    check (status in ('unconfigured','configured','connected','error','disconnected')),
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_sync_at timestamptz,
  account jsonb,
  error text,
  updated_at timestamptz default now(),
  primary key (business_id, provider_id)
);

-- 10. API tokens used by WorkBuddy's BizPilot connector (only the SHA-256 hash is stored)
create table if not exists api_tokens (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  name text not null default 'WorkBuddy connector',
  token_hash text not null unique,
  token_hint text default '',
  created_at timestamptz default now(),
  last_used_at timestamptz
);

-- 11. Row Level Security ------------------------------------------------------------
alter table businesses enable row level security;
drop policy if exists "own business" on businesses;
create policy "own business" on businesses
  for all using (owner_id = auth.uid()) with check (owner_id = auth.uid());

-- Inventory policy, held stock, expiry and returns (also in team-features.sql) ---------
alter table products add column if not exists unavailable int default 0;
alter table products add column if not exists safety_stock int default 0;
alter table products add column if not exists max_stock int default 0;
alter table products add column if not exists order_multiple int default 1;
alter table products add column if not exists expiry_date text default '';

create table if not exists return_cases (
  id text primary key default gen_random_uuid()::text,
  business_id uuid not null references businesses (id) on delete cascade,
  return_number text not null,
  order_id text,
  product_id text,
  customer_name text default '',
  quantity int default 1,
  reason text default 'other',
  condition text default 'opened',
  notes text default '',
  photo_url text default '',
  status text default 'open' check (status in ('open','resolved','rejected')),
  resolution text,
  refund_amount numeric(12,2) default 0,
  refund_status text default 'none' check (refund_status in ('none','pending_approval','refunded')),
  created_at timestamptz default now(),
  resolved_at timestamptz,
  unique (business_id, return_number)
);


do $$
declare t text;
begin
  foreach t in array array[
    'products','stock_movements','suppliers','purchase_orders','sales_orders','expenses',
    'invoices','reviews','support_tickets','campaigns','content_items','approval_requests',
    'audit_log','notifications','agent_tasks','return_cases'
  ]
  loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "tenant isolation" on %I', t);
    execute format(
      'create policy "tenant isolation" on %I for all using (is_business_owner(business_id)) with check (is_business_owner(business_id))',
      t
    );
  end loop;
end $$;

-- Credentials and connector tokens: RLS on with no policy = no browser access at all.
-- Only the BizPilot server (service role key, which bypasses RLS) reads or writes them.
alter table integrations enable row level security;
alter table api_tokens enable row level security;

-- Server-only settings, e.g. BizPilot's saved WorkBuddy login. No policy = server only.
create table if not exists server_secrets (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
alter table server_secrets enable row level security;

-- 12. Indexes ---------------------------------------------------------------------------
create index if not exists idx_products_biz on products (business_id);
create index if not exists idx_moves_biz_date on stock_movements (business_id, date desc);
create index if not exists idx_sales_biz_date on sales_orders (business_id, date desc);
create index if not exists idx_approvals_biz_status on approval_requests (business_id, status);
create index if not exists idx_audit_biz_date on audit_log (business_id, at desc);
create index if not exists idx_agent_tasks_biz on agent_tasks (business_id, created_at desc);

-- Marketing photos and videos the owner uploads in Marketing Studio → New content.
-- Public read (social platforms must fetch them); owners can only upload into their own business folder.
insert into storage.buckets (id, name, public, file_size_limit)
values ('marketing-media', 'marketing-media', true, 52428800)
on conflict (id) do nothing;
drop policy if exists "marketing media upload" on storage.objects;
create policy "marketing media upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'marketing-media' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
drop policy if exists "marketing media delete" on storage.objects;
create policy "marketing media delete" on storage.objects for delete to authenticated
  using (bucket_id = 'marketing-media' and public.is_business_owner(((storage.foldername(name))[1])::uuid));
