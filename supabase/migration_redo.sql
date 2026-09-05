-- Run this in the Supabase SQL Editor for your EXISTING project.
-- (Already applied directly to the production database this session —
-- this file just keeps the repo's migration history in sync.)
--
-- Adds redo/remake tracking to production entries. A redo is redoing or
-- remaking a prior procedure — a lab remake, warranty work, correcting a
-- failed restoration — usually done at no charge to the patient. Tracked
-- separately since it's real work worth logging, but it isn't new
-- revenue-generating production the way the rest of the entry is.

alter table production add column if not exists is_redo boolean not null default false;
alter table production add column if not exists redo_notes text;
