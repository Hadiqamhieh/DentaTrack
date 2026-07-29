-- Run this in the Supabase SQL Editor for your EXISTING project.
-- Adds support for split transactions (one bank transaction divided across
-- multiple expense categories).

alter table bank_transactions add column if not exists splits jsonb;
