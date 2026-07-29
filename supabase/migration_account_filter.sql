-- Run this in the Supabase SQL Editor.
-- Tracks which specific connected account (e.g. Chequing vs Savings vs a
-- credit card) each Plaid-synced transaction belongs to, so the feed can be
-- filtered by account, not just by bank connection as a whole.

alter table bank_transactions add column if not exists plaid_account_id text;
