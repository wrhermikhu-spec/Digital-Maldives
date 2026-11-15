-- Gift card shop schema. Run once in Supabase → SQL Editor → New query → Run.
-- All access goes through the Vercel API using the service-role/secret key,
-- so RLS is ON with no policies: the public anon key can read nothing.

create extension if not exists pgcrypto;

-- ---------- settings (single row) ----------
create table if not exists public.settings (
  id int primary key default 1 check (id = 1),
  name text not null default 'Gift Card Shop',
  currency text not null default 'MVR',
  bank_name text default '',
  account_name text default '',
  account_number text default '',
  instructions text default ''
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- catalog ----------
create table if not exists public.cards (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  value_label text default '',
  description text default '',
  price numeric(10,2) not null check (price >= 0),
  color text default '#0f766e',
  active boolean not null default true,
  sort int not null default 0,
  created_at timestamptz not null default now()
);

-- ---------- PIN inventory ----------
create table if not exists public.pins (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.cards(id) on delete cascade,
  code text not null,
  used boolean not null default false,
  order_id uuid,
  added_at timestamptz not null default now(),
  used_at timestamptz,
  unique (card_id, code)
);
create index if not exists pins_available on public.pins (card_id, added_at) where not used;

-- ---------- orders ----------
create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  card_id uuid references public.cards(id) on delete set null,
  card_name text not null,
  price numeric(10,2) not null,
  currency text not null,
  buyer_name text not null,
  contact text not null,
  slip_path text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  pin text,
  note text,
  -- buyer network + device (fraud checks)
  ip text,
  city text,
  region text,
  country text,
  visitor_id text,
  device_model text,
  os text,
  browser text,
  screen text,
  language text,
  timezone text,
  user_agent text,
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);
create index if not exists orders_created on public.orders (created_at desc);
create index if not exists orders_ip on public.orders (ip, created_at desc);

-- Card list with live stock count
create or replace view public.card_stock with (security_invoker = true) as
  select c.*, (select count(*) from public.pins p where p.card_id = c.id and not p.used)::int as stock
  from public.cards c;

-- ---------- lock everything down ----------
alter table public.settings enable row level security;
alter table public.cards    enable row level security;
alter table public.pins     enable row level security;
alter table public.orders   enable row level security;
revoke all on public.settings, public.cards, public.pins, public.orders, public.card_stock from anon, authenticated;

-- ---------- atomic approval: one PIN can never go to two orders ----------
create or replace function public.approve_order(p_order uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_card uuid;
  v_pin  record;
begin
  select card_id into v_card from orders where id = p_order and status = 'pending' for update;
  if not found then raise exception 'ORDER_NOT_PENDING'; end if;

  select id, code into v_pin from pins
   where card_id = v_card and not used
   order by added_at
   limit 1
   for update skip locked;
  if not found then raise exception 'NO_STOCK'; end if;

  update pins   set used = true, order_id = p_order, used_at = now() where id = v_pin.id;
  update orders set status = 'approved', pin = v_pin.code, reviewed_at = now() where id = p_order;
  return v_pin.code;
end $$;
revoke execute on function public.approve_order(uuid) from public, anon, authenticated;
grant execute on function public.approve_order(uuid) to service_role;

-- ---------- private bucket for payment slips ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('slips', 'slips', false, 3145728, array['image/jpeg'])
on conflict (id) do nothing;
