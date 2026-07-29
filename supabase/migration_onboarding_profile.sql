-- Run this in the Supabase SQL Editor.
-- Adds the extra professional-profile fields captured during onboarding
-- (province/state, license number, school, graduating year).

alter table profiles add column if not exists province text;
alter table profiles add column if not exists license_number text;
alter table profiles add column if not exists school text;
alter table profiles add column if not exists graduating_year text;
