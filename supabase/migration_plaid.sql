-- Run this in the Supabase SQL Editor for your EXISTING project.
-- Adds real bank-connection (Plaid) support without touching your existing data.

-- New columns on connected_accounts, linking each connected account back to
-- the Plaid connection ("Item") it came from.
alter table connected_accounts add column if not exists plaid_item_id uuid;
alter table connected_accounts add column if not exists plaid_account_id text;

-- One row per real bank connection. access_token is a sensitive credential
-- that can pull real transaction data — this table intentionally gets NO
-- row-level-security policy granting select/insert to the anon/authenticated
-- role. It's only ever touched by serverless functions using the Supabase
-- SERVICE ROLE key (which bypasses RLS), so the browser can never query it.
create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users on delete cascade not null,
  item_id text not null unique,
  access_token text not null,
  institution_id text,
  institution_name text,
  cursor text,
  created_at timestamptz default now()
);
alter table plaid_items enable row level security;
-- No policies created on purpose — see note above.

alter table connected_accounts
  add constraint connected_accounts_plaid_item_fkey
  foreign key (plaid_item_id) references plaid_items(id) on delete cascade;

-- Lets us dedupe when re-syncing the same transaction from Plaid.
alter table bank_transactions add column if not exists plaid_transaction_id text;
create unique index if not exists bank_transactions_plaid_txn_uidx
  on bank_transactions(plaid_transaction_id) where plaid_transaction_id is not null;
