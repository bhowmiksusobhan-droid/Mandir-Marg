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

alter table public.temple_suggestions enable row level security;

-- Visitors may only add new pending suggestions. They cannot read, edit,
-- approve or delete anything. Moderators use the Supabase dashboard (service
-- role) or a future authenticated admin UI.
drop policy if exists "Anyone may submit a pending suggestion" on public.temple_suggestions;
create policy "Anyone may submit a pending suggestion"
  on public.temple_suggestions
  for insert
  to anon, authenticated
  with check (status = 'pending');

-- Optional: allow signed-in moderators to read suggestions.
-- Create a table of moderators and an is_moderator() function before enabling
-- this policy. The dashboard is enough for the first version.
--
-- create policy "Moderators may read suggestions"
--   on public.temple_suggestions
--   for select
--   to authenticated
--   using (public.is_moderator(auth.uid()));
