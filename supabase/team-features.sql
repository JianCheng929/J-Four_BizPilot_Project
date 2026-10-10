-- ============================================================
-- BizPilot: inventory policy, held stock, expiry and returns
-- Run once in the Supabase SQL Editor (Dashboard → SQL Editor → New query → Run).
-- Safe to re-run. Adds columns and one table; existing data is kept.
-- ============================================================

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

alter table return_cases enable row level security;
drop policy if exists "tenant isolation" on return_cases;
create policy "tenant isolation" on return_cases for all
  using (is_business_owner(business_id)) with check (is_business_owner(business_id));
