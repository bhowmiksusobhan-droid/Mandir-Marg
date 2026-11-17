-- Mandir Marg — optional shared contributions table (Supabase / PostgreSQL)
-- Run this in the Supabase SQL editor after creating a free project.
-- Then copy the project URL and anon public key into js/config.js.

create table if not exists public.temple_suggestions (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'add' check (kind in ('add', 'edit')),
  temple_name text not null check (char_length(temple_name) between 2 and 120),
  deity text,
  city text,
  address text,
  notes text,
  osm_id text,
  lat double precision,
  lng double precision,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  created_at timestamptz not null default now()
);

create index if not exists temple_suggestions_status_idx
  on public.temple_suggestions (status, created_at desc);

-- Photos arrive as a downscaled JPEG data URL. Canvas export in the browser
-- removes EXIF before upload. The cap keeps one row from exhausting the free
-- database quota; tools/publish_temples.py moves photos into static files.
alter table public.temple_suggestions
  add column if not exists photo text;

alter table public.temple_suggestions
  drop constraint if exists temple_suggestions_photo_size;
alter table public.temple_suggestions
  add constraint temple_suggestions_photo_size
  check (photo is null or char_length(photo) <= 1200000);

alter table public.temple_suggestions enable row level security;

-- Visitors may only add new pending suggestions. They cannot edit, approve or
-- delete anything. Moderators use the Supabase dashboard (service role) or a
-- future authenticated admin UI.
drop policy if exists "Anyone may submit a pending suggestion" on public.temple_suggestions;
create policy "Anyone may submit a pending suggestion"
  on public.temple_suggestions
  for insert
  to anon, authenticated
  with check (status = 'pending');

-- Approved rows are public by definition: they are what the map publishes.
-- This also lets tools/publish_temples.py run with the anon key if you prefer.
drop policy if exists "Anyone may read approved temples" on public.temple_suggestions;
create policy "Anyone may read approved temples"
  on public.temple_suggestions
  for select
  to anon, authenticated
  using (status = 'approved');

-- Optional: allow signed-in moderators to read suggestions.
-- Create a table of moderators and an is_moderator() function before enabling
-- this policy. The dashboard is enough for the first version.
--
-- create policy "Moderators may read suggestions"
--   on public.temple_suggestions
--   for select
--   to authenticated
--   using (public.is_moderator(auth.uid()));
