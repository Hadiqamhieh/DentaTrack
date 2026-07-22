-- DentaTrack schema — run this in the Supabase SQL Editor (Dashboard > SQL Editor > New query)
-- Every table is scoped to auth.uid() via Row Level Security, so each dentist only ever
-- sees their own data even though they all share the same database.

create table profiles (
  id uuid references auth.users on delete cascade primary key,
  name text,
  corp_name text,
  is_corp boolean default false,
  salary numeric default 0,
  dividends numeric default 0,
  created_at timestamptz default now()
);

create table practices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  name text not null,
  address text,
  city text,
  province text,
  postal_code text,
  pct numeric not null,
  basis text not null,            -- 'production' | 'collections'
  deducts_lab_fees boolean default false,
  guarantee numeric default 0,
  color text default '#0F6E56',
  created_at timestamptz default now()
);

create table production (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  practice_id uuid references practices on delete cascade,
  date date not null,
  production numeric not null default 0,
  lab_fees numeric not null default 0,
  source text default 'manual',   -- 'manual' | 'daysheet'
  created_at timestamptz default now()
);

create table expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  date date not null,
  vendor text,
  category text,
  amount numeric not null,
  tax_deductible boolean default false,
  corp_expense boolean default false,
  receipt boolean default false,
  created_at timestamptz default now()
);

create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  date date not null,
  description text,
  amount numeric not null,
  type text,                       -- 'collection' | 'business' | 'personal' | 'review'
  reviewed boolean default false,
  practice_id uuid references practices on delete set null,
  user_tagged boolean default false,
  auto_tagged boolean default false,
  matched_rule uuid,
  category text,
  tax_deductible boolean,
  deductible_fraction numeric,
  corp_expense boolean,
  receipt boolean,
  notes text,
  manual boolean default false,
  plaid_transaction_id text,
  created_at timestamptz default now()
);
create unique index bank_transactions_plaid_txn_uidx on bank_transactions(plaid_transaction_id) where plaid_transaction_id is not null;

create table bank_rules (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  match_text text not null,
  match_type text default 'contains',  -- 'contains' | 'starts_with' | 'equals'
  type text,
  practice_id uuid references practices on delete set null,
  category text,
  tax_deductible boolean,
  deductible_fraction numeric,
  corp_expense boolean,
  applied_count int default 0,
  created_from text default 'auto',
  created_at timestamptz default now()
);

create table connected_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  name text,
  mask text,
  type text,           -- 'depository' | 'credit'
  institution text,
  label text,
  last_sync date,
  connected boolean default true,
  plaid_item_id uuid,      -- references plaid_items(id), added below after that table exists
  plaid_account_id text,   -- Plaid's id for this specific account within the item
  created_at timestamptz default now()
);

-- ── Plaid connections ───────────────────────────────────────────────
-- One row per bank connection ("Item" in Plaid's terms). access_token is a
-- sensitive credential that can pull real transaction data, so this table
-- intentionally gets NO row-level-security policy granting select/insert to
-- the anon/authenticated role. It is only ever read or written by serverless
-- functions using the Supabase SERVICE ROLE key, which bypasses RLS — the
-- browser can never see or query this table directly.
create table plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  item_id text not null unique,
  access_token text not null,
  institution_id text,
  institution_name text,
  cursor text,              -- pagination cursor for transactions/sync
  created_at timestamptz default now()
);
alter table plaid_items enable row level security;
-- No policies created on purpose — see note above.

alter table connected_accounts add constraint connected_accounts_plaid_item_fkey
  foreign key (plaid_item_id) references plaid_items(id) on delete cascade;

-- ── Row Level Security ──────────────────────────────────────────────
-- Turns on per-row ownership checks so one dentist's queries can never
-- return or modify another dentist's rows, even though they share tables.

alter table profiles            enable row level security;
alter table practices           enable row level security;
alter table production          enable row level security;
alter table expenses            enable row level security;
alter table bank_transactions   enable row level security;
alter table bank_rules          enable row level security;
alter table connected_accounts  enable row level security;

create policy "own profile"   on profiles   for all using (auth.uid() = id) with check (auth.uid() = id);
create policy "own practices" on practices  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own production" on production for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own expenses"  on expenses   for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own banks"     on bank_transactions for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own rules"     on bank_rules for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "own accounts"  on connected_accounts for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Auto-create a profile row the moment someone signs up
create function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name) values (new.id, new.raw_user_meta_data->>'name');
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
