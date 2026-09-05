-- Run this in the Supabase SQL Editor for your EXISTING project.
-- (Already applied directly to the production database this session —
-- this file just keeps the repo's migration history in sync.)
--
-- Reserves a field for a future multi-line procedure entry screen: an array
-- of {code, description, fee} objects (CDT codes in the US, provincial
-- fee-guide codes in Canada). Nothing in the UI populates this yet.

alter table production add column if not exists procedures jsonb;
comment on column production.procedures is
  'Reserved for future multi-line procedure entry: an array of {code, description, fee} objects (e.g. CDT codes in the US, provincial fee-guide codes in Canada). Not yet populated by the UI.';
