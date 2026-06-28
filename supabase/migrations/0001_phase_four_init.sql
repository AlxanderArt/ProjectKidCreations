-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ ProjectKidCreations · Phase Four — ACCESS GRANTED                          ║
-- ║ 0001_phase_four_init.sql — initial dashboard schema                       ║
-- ╠══════════════════════════════════════════════════════════════════════════╣
-- ║ Backs the authenticated "ACCESS GRANTED" dashboard (phase-four/). Shapes  ║
-- ║ mirror phase-four/mock-data.js so flipping window.PKC_DATA_MODE to "live" ║
-- ║ is a drop-in once the api/dashboard/* Edge functions read these tables.   ║
-- ║                                                                            ║
-- ║ STATUS: draft migration, NOT yet applied. The Supabase project is blocked ║
-- ║ on billing (see Project Kid Creations/PHASE-FOUR-SETUP-CHECKLIST.md §1).  ║
-- ║ Apply via the Supabase MCP / CLI once the project exists.                  ║
-- ║                                                                            ║
-- ║ SECURITY MODEL                                                             ║
-- ║  • RLS enabled on every table. Catalog tables (ranks, badges) are world-  ║
-- ║    readable to authenticated users; all per-user tables are owner-scoped  ║
-- ║    via auth.uid(). No policy ever trusts user-editable metadata.          ║
-- ║  • Writes happen server-side from Edge functions using the SERVICE ROLE    ║
-- ║    key (bypasses RLS). That key is server-only and must never reach the    ║
-- ║    browser. Ownership is derived from the verified session, not the body.  ║
-- ║  • The one convenience view uses security_invoker = true so it runs with   ║
-- ║    the caller's RLS, not the definer's.                                    ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- Extensions ----------------------------------------------------------------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ───────────────────────────────────────────────────────────────────────────
-- 1 · ranks — catalog (ordered ladder). Referenced by profiles.rank_code.
--     Catalog tables are created first so profiles can FK into ranks.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.ranks (
  code      text primary key,
  label     text not null,
  min_xp    integer not null,
  sort      integer not null
);
comment on table public.ranks is 'XP rank ladder catalog. min_xp is the floor to hold the rank.';

-- ───────────────────────────────────────────────────────────────────────────
-- 2 · badges — catalog (12 seed rows below). Per-user state in user_badges.
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.badges (
  id        text primary key,
  label     text not null,
  glyph     text not null,
  rarity    text not null check (rarity in ('common','rare','epic','legendary')),
  criteria  text not null,
  sort      integer not null
);
comment on table public.badges is 'Badge catalog: label/glyph/rarity/criteria. Unlock state lives in user_badges.';

-- ───────────────────────────────────────────────────────────────────────────
-- 3 · profiles — one row per operator, keyed to auth.users
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.profiles (
  id              uuid primary key references auth.users (id) on delete cascade,
  email           text not null,
  username        text unique,
  display_name    text,
  avatar_url      text,
  rank_code       text not null default 'beginner' references public.ranks (code),
  xp_total        integer not null default 0 check (xp_total >= 0),
  streak_current  integer not null default 0 check (streak_current >= 0),
  streak_longest  integer not null default 0 check (streak_longest >= 0),
  last_active_date date,
  notifications   boolean not null default true,
  member_since    date not null default (now() at time zone 'utc')::date,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
comment on table public.profiles is 'Operator identity + denormalized XP/streak cache. One row per auth.users.';

-- ───────────────────────────────────────────────────────────────────────────
-- 4 · user_badges — per-user unlock state
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.user_badges (
  user_id    uuid not null references public.profiles (id) on delete cascade,
  badge_id   text not null references public.badges (id) on delete cascade,
  unlocked   boolean not null default false,
  awarded_at timestamptz,
  primary key (user_id, badge_id)
);
comment on table public.user_badges is 'Which badges an operator has unlocked, and when.';

-- ───────────────────────────────────────────────────────────────────────────
-- 5 · xp_ledger — append-only XP events; profiles.xp_total is the cached sum
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.xp_ledger (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  amount     integer not null,
  reason     text not null,
  created_at timestamptz not null default now()
);
create index if not exists xp_ledger_user_idx on public.xp_ledger (user_id, created_at desc);
comment on table public.xp_ledger is 'Append-only XP grants. Sum == profiles.xp_total (kept in sync server-side).';

-- ───────────────────────────────────────────────────────────────────────────
-- 6 · builds — gallery submissions
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.builds (
  id           text primary key,                       -- e.g. PKC-B042
  user_id      uuid not null references public.profiles (id) on delete cascade,
  title        text not null,
  likes        integer not null default 0 check (likes >= 0),
  seed         integer not null default 0,
  submitted_at timestamptz not null default now()
);
create index if not exists builds_user_idx on public.builds (user_id, submitted_at desc);
comment on table public.builds is 'Operator build submissions shown in the dashboard gallery.';

-- ───────────────────────────────────────────────────────────────────────────
-- 7 · orders — storefront orders (header)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.orders (
  id         text primary key,                          -- e.g. PKC-2031
  user_id    uuid not null references public.profiles (id) on delete cascade,
  total      numeric(10,2) not null default 0 check (total >= 0),
  status     text not null default 'Pending'
               check (status in ('Pending','Shipped','Delivered','Cancelled')),
  placed_at  timestamptz not null default now()
);
create index if not exists orders_user_idx on public.orders (user_id, placed_at desc);
comment on table public.orders is 'Storefront order headers. Line items in order_items.';

-- ───────────────────────────────────────────────────────────────────────────
-- 8 · order_items — order line items (normalized)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.order_items (
  id        uuid primary key default gen_random_uuid(),
  order_id  text not null references public.orders (id) on delete cascade,
  label     text not null,
  sort      integer not null default 0
);
create index if not exists order_items_order_idx on public.order_items (order_id, sort);
comment on table public.order_items is 'Line items for an order (one row per item label).';

-- ───────────────────────────────────────────────────────────────────────────
-- 9 · activity_events — the activity feed (also fed by n8n "Dashboard Event Log")
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.activity_events (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles (id) on delete cascade,
  type       text not null
               check (type in ('login','badge_unlocked','build_submitted',
                               'order_placed','rank_promoted','profile_edited')),
  label      text not null,
  at         timestamptz not null default now()
);
create index if not exists activity_user_idx on public.activity_events (user_id, at desc);
comment on table public.activity_events is 'Reverse-chronological operator activity feed.';

-- ───────────────────────────────────────────────────────────────────────────
-- 10 · streak_days — calendar-aligned daily activity intensity (the streak grid)
-- ───────────────────────────────────────────────────────────────────────────
create table if not exists public.streak_days (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  date           date not null,
  activity_count smallint not null default 0 check (activity_count between 0 and 3),
  primary key (user_id, date)
);
comment on table public.streak_days is '90-day streak grid: per-day activity intensity 0..3.';

-- ════════════════════════════════════════════════════════════════════════════
-- Catalog seed data
-- ════════════════════════════════════════════════════════════════════════════

-- Ranks (XP ladder) ----------------------------------------------------------
insert into public.ranks (code, label, min_xp, sort) values
  ('rookie',  'ROOKIE',   0,    0),
  ('beginner','BEGINNER', 1,    1),
  ('builder', 'BUILDER',  100,  2),
  ('veteran', 'VETERAN',  500,  3),
  ('operator','OPERATOR', 1500, 4)
on conflict (code) do nothing;

-- Badges (12) — mirrors phase-four/badges.js catalog ------------------------
insert into public.badges (id, label, glyph, rarity, criteria, sort) values
  ('verified',      'VERIFIED',       '◆', 'rare',      'Confirm your email after the drop link.',                0),
  ('early_operator','EARLY OPERATOR', '★', 'legendary', 'First 500 operators through the door.',                  1),
  ('profile_maxed', 'PROFILE MAXED',  '⬢', 'epic',      'Complete every profile field — avatar, shipping, comms.', 2),
  ('first_build',   'FIRST BUILD',    '◉', 'rare',      'Submit your first build to the gallery.',                3),
  ('day_one',       'DAY-1 OPERATOR', '▲', 'legendary', 'Sign in on launch day.',                                 4),
  ('returning',     'RETURNING',      '▼', 'common',    'Come back after a 7-day gap.',                           5),
  ('veteran',       'VETERAN',        '✦', 'epic',      'Reach 500 XP.',                                          6),
  ('builder',       'BUILDER',        '✚', 'rare',      'Reach 100 XP.',                                          7),
  ('beginner',      'BEGINNER',       '◇', 'common',    'Create your account.',                                   8),
  ('connected',     'CONNECTED',      '⌬', 'common',    'Link a comms channel — Discord or SMS.',                9),
  ('located',       'LOCATED',        '⌖', 'common',    'Add a shipping address.',                               10),
  ('eighteen_plus', '18+',            '⚠', 'rare',      'Confirm age gate.',                                     11)
on conflict (id) do nothing;

-- ════════════════════════════════════════════════════════════════════════════
-- Housekeeping function + trigger
--   On a new auth.users row: create the profile, seed the BEGINNER badge,
--   and log the first-sign-in activity event. SECURITY DEFINER so it can write
--   across schemas during the auth hook; search_path pinned to avoid hijack.
-- ════════════════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email, username, display_name)
  values (
    new.id,
    new.email,
    split_part(new.email, '@', 1),
    upper(split_part(new.email, '@', 1))
  )
  on conflict (id) do nothing;

  insert into public.user_badges (user_id, badge_id, unlocked, awarded_at)
  values (new.id, 'beginner', true, now())
  on conflict (user_id, badge_id) do nothing;

  insert into public.activity_events (user_id, type, label, at)
  values (new.id, 'login', 'First sign-in', now());

  return new;
end;
$$;
comment on function public.handle_new_user is 'Auth hook: provisions profile + seeds BEGINNER badge + logs first sign-in.';

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ════════════════════════════════════════════════════════════════════════════
-- Row Level Security
--   Per-user tables: only the owner (auth.uid()) may read their rows. Writes go
--   through the service role (RLS-bypassing) in Edge functions, so we expose
--   only SELECT policies to authenticated clients here. Catalog tables are
--   read-only reference data, world-readable to authenticated users.
-- ════════════════════════════════════════════════════════════════════════════
alter table public.profiles        enable row level security;
alter table public.ranks           enable row level security;
alter table public.badges          enable row level security;
alter table public.user_badges     enable row level security;
alter table public.xp_ledger       enable row level security;
alter table public.builds          enable row level security;
alter table public.orders          enable row level security;
alter table public.order_items     enable row level security;
alter table public.activity_events enable row level security;
alter table public.streak_days     enable row level security;

-- Catalog: any authenticated user may read ----------------------------------
create policy ranks_read  on public.ranks  for select to authenticated using (true);
create policy badges_read on public.badges for select to authenticated using (true);

-- Owner-scoped reads --------------------------------------------------------
create policy profiles_own       on public.profiles        for select to authenticated using (id = auth.uid());
create policy profiles_update_own on public.profiles       for update to authenticated using (id = auth.uid()) with check (id = auth.uid());
create policy user_badges_own    on public.user_badges     for select to authenticated using (user_id = auth.uid());
create policy xp_ledger_own      on public.xp_ledger       for select to authenticated using (user_id = auth.uid());
create policy builds_own         on public.builds          for select to authenticated using (user_id = auth.uid());
create policy orders_own         on public.orders          for select to authenticated using (user_id = auth.uid());
create policy activity_own       on public.activity_events for select to authenticated using (user_id = auth.uid());
create policy streak_own         on public.streak_days     for select to authenticated using (user_id = auth.uid());
-- order_items: owner reached through the parent order
create policy order_items_own on public.order_items for select to authenticated
  using (exists (
    select 1 from public.orders o
    where o.id = order_items.order_id and o.user_id = auth.uid()
  ));

-- ════════════════════════════════════════════════════════════════════════════
-- Convenience view: dashboard_me — the caller's profile joined to their rank.
--   security_invoker = true → the view runs under the CALLER's RLS, so it can
--   never leak another operator's row even though it is defined once globally.
-- ════════════════════════════════════════════════════════════════════════════
create or replace view public.dashboard_me
with (security_invoker = true) as
  select
    p.id, p.email, p.username, p.display_name, p.avatar_url,
    p.xp_total, p.streak_current, p.streak_longest, p.last_active_date,
    p.notifications, p.member_since,
    r.code  as rank_code,
    r.label as rank_label,
    r.min_xp as rank_min_xp
  from public.profiles p
  join public.ranks r on r.code = p.rank_code;
comment on view public.dashboard_me is 'Caller-scoped (security_invoker) profile+rank join for /api/dashboard/me.';
