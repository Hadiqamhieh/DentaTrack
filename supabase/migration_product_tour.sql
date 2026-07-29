-- Run this in the Supabase SQL Editor.
-- Adds a one-time product tour, shown only to brand-new accounts right
-- after they finish onboarding.

-- Default true backfills every EXISTING account as "already done" (no tour
-- for people who are already using the app). The signup trigger below
-- explicitly overrides this to false for genuinely new accounts only.
alter table profiles add column if not exists tour_completed boolean default true;

create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, name, tour_completed)
  values (new.id, new.raw_user_meta_data->>'name', false);
  return new;
end;
$$ language plpgsql security definer;
