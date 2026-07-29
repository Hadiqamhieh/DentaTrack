-- Run this in the Supabase SQL Editor.
-- Adds account deactivation support. Deactivating revokes bank connections
-- (and the transaction data tied to them) but preserves everything the
-- dentist entered by hand — practices, production, manual expenses — so
-- reactivating is simple and non-destructive.

alter table profiles add column if not exists deactivated boolean default false;
