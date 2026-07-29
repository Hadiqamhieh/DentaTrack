-- Run this in the Supabase SQL Editor.
-- Links each Plaid-synced transaction to the specific bank connection it
-- came from, and — critically — sets it up so that disconnecting a bank
-- automatically deletes its transactions too (via cascade), instead of
-- relying on app code to remember to clean them up.

alter table bank_transactions add column if not exists plaid_item_id uuid;

alter table bank_transactions
  add constraint bank_transactions_plaid_item_fkey
  foreign key (plaid_item_id) references plaid_items(id) on delete cascade;
