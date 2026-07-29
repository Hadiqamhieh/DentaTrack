-- Run this in the Supabase SQL Editor.
-- Fixes a mistake in the original Plaid migration: the unique index on
-- plaid_transaction_id was created as a PARTIAL index (only applying to
-- non-null values). Postgres won't match a partial index against a plain
-- "ON CONFLICT (plaid_transaction_id)" clause, which is what causes:
--   "there is no unique or exclusion constraint matching the ON CONFLICT specification"
--
-- The fix is a plain (non-partial) unique index instead. This is safe for
-- manually-entered transactions (which have plaid_transaction_id = null),
-- because Postgres never treats two NULLs as duplicates of each other under
-- a unique index — only actual matching Plaid transaction IDs get deduped.

drop index if exists bank_transactions_plaid_txn_uidx;
create unique index bank_transactions_plaid_txn_uidx on bank_transactions(plaid_transaction_id);
