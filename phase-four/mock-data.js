/* ProjectKidCreations — phase-four/mock-data.js
 * Frontend-only mock dataset for the ACCESS GRANTED dashboard preview.
 * Shapes mirror the eventual /api/dashboard/me response so the live swap
 * (window.PKC_DATA_MODE = "live") is a drop-in.
 */

// ── User ───────────────────────────────────────────────────────────
export const MOCK_USER = {
  id: "mock-user-001",
  email: "maxwell@example.com",
  username: "maxwell",
  displayName: "MAXWELL",
  avatarUrl: null,
  rank: {
    code: "builder",
    label: "BUILDER",
    minXp: 100,
    nextLabel: "VETERAN",
    nextMinXp: 500
  },
  xp: {
    current: 287,
    currentRankMin: 100,
    nextRankMin: 500
  },
  streak: {
    current: 7,
    longest: 14,
    lastActiveDate: "2026-05-11"
  },
  completion: {
    pct: 73,
    missing: ["avatar", "shipping"]
  },
  memberSince: "2026-04-20",
  notifications: true
};

// ── Badges (unlocked state — 4 of 12) ──────────────────────────────
// The catalog (label/glyph/criteria/rarity) lives in badges.js. This is
// just the per-user unlock state.
export const MOCK_BADGES = [
  { id: "verified",      unlocked: true,  awardedAt: "2026-04-20" },
  { id: "early_operator",unlocked: true,  awardedAt: "2026-04-20" },
  { id: "beginner",      unlocked: true,  awardedAt: "2026-04-20" },
  { id: "builder",       unlocked: true,  awardedAt: "2026-04-28" },
  { id: "profile_maxed", unlocked: false, awardedAt: null },
  { id: "first_build",   unlocked: false, awardedAt: null },
  { id: "day_one",       unlocked: false, awardedAt: null },
  { id: "returning",     unlocked: false, awardedAt: null },
  { id: "veteran",       unlocked: false, awardedAt: null },
  { id: "connected",     unlocked: false, awardedAt: null },
  { id: "located",       unlocked: false, awardedAt: null },
  { id: "eighteen_plus", unlocked: false, awardedAt: null }
];

// ── Builds (6) ─────────────────────────────────────────────────────
export const MOCK_BUILDS = [
  { id: "PKC-B042", title: "GLOCK 19 — SCARFACE",        submittedAt: "2026-05-10", likes: 47, seed: 1 },
  { id: "PKC-B038", title: "AR BUILD — PHANTOM",          submittedAt: "2026-05-06", likes: 32, seed: 2 },
  { id: "PKC-B031", title: "DRACO SETUP — APEX",          submittedAt: "2026-05-02", likes: 28, seed: 3 },
  { id: "PKC-B024", title: "CUSTOM SWITCH — BLACK OPS",   submittedAt: "2026-04-28", likes: 19, seed: 4 },
  { id: "PKC-B019", title: "GLOCK 45 — RECON",            submittedAt: "2026-04-24", likes: 12, seed: 5 },
  { id: "PKC-B011", title: "AK VARIANT — SPECTRE",        submittedAt: "2026-04-21", likes: 8,  seed: 6 }
];

// ── Orders (4) ─────────────────────────────────────────────────────
export const MOCK_ORDERS = [
  {
    id: "PKC-2031",
    placedAt: "2026-05-10",
    items: ["Glock Switch Mod v2 — Tactical Black", "Magazine Coupler"],
    total: 84.00,
    status: "Delivered"
  },
  {
    id: "PKC-2027",
    placedAt: "2026-05-07",
    items: ["Draco Handguard Mk1"],
    total: 49.00,
    status: "Shipped"
  },
  {
    id: "PKC-2024",
    placedAt: "2026-05-04",
    items: ["AR Lower Receiver — Hi-Vis", "Trigger Pin Set"],
    total: 132.00,
    status: "Pending"
  },
  {
    id: "PKC-2018",
    placedAt: "2026-04-30",
    items: ["Trigger Pin Set"],
    total: 18.00,
    status: "Cancelled"
  }
];

// ── Activity feed (12, reverse chronological) ──────────────────────
export const MOCK_ACTIVITY = [
  { id: "a12", type: "badge_unlocked",  label: "Unlocked badge // BUILDER",          at: "2026-05-11T18:42:00Z" },
  { id: "a11", type: "build_submitted", label: "Submitted build // GLOCK 19 — SCARFACE", at: "2026-05-10T22:14:00Z" },
  { id: "a10", type: "order_placed",    label: "Order placed // PKC-2031",           at: "2026-05-10T15:01:00Z" },
  { id: "a09", type: "login",           label: "Signed in",                          at: "2026-05-10T08:30:00Z" },
  { id: "a08", type: "build_submitted", label: "Submitted build // AR BUILD — PHANTOM",  at: "2026-05-06T20:18:00Z" },
  { id: "a07", type: "rank_promoted",   label: "Rank promoted // BEGINNER → BUILDER", at: "2026-04-28T19:00:00Z" },
  { id: "a06", type: "build_submitted", label: "Submitted build // DRACO SETUP — APEX", at: "2026-05-02T17:45:00Z" },
  { id: "a05", type: "order_placed",    label: "Order placed // PKC-2024",           at: "2026-05-04T12:08:00Z" },
  { id: "a04", type: "profile_edited",  label: "Profile updated // display name",    at: "2026-04-26T11:30:00Z" },
  { id: "a03", type: "badge_unlocked",  label: "Unlocked badge // EARLY OPERATOR",   at: "2026-04-20T14:22:00Z" },
  { id: "a02", type: "badge_unlocked",  label: "Unlocked badge // BEGINNER",         at: "2026-04-20T14:21:00Z" },
  { id: "a01", type: "login",           label: "First sign-in",                      at: "2026-04-20T14:20:00Z" }
];

// ── Streak grid (90 days, calendar-aligned) ────────────────────────
// activityCount levels: 0 (none) / 1 (low) / 2 (med) / 3 (high)
// Build a deterministic grid that:
//   • last 7 days = active (current streak)
//   • includes a 14-day run somewhere in the middle
//   • realistic gaps elsewhere
function buildStreakGrid() {
  const today = new Date("2026-05-11T00:00:00Z");
  const days = 90;
  const grid = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    grid.push({
      date: d.toISOString().slice(0, 10),
      activityCount: 0
    });
  }

  // Helper: assign intensity by index (0 = oldest, days-1 = today)
  function set(idx, count) {
    if (idx >= 0 && idx < grid.length) grid[idx].activityCount = count;
  }

  // Last 7 days = current streak (today is grid[89])
  for (let i = days - 7; i < days; i++) {
    // vary intensity: today=high, yesterday=high, then mix
    const offset = days - 1 - i;
    set(i, offset === 0 ? 3 : offset === 1 ? 3 : offset === 2 ? 2 : offset === 3 ? 3 : offset === 4 ? 1 : offset === 5 ? 2 : 2);
  }

  // 14-day streak in the middle (days 35-48)
  for (let i = 35; i < 49; i++) {
    set(i, (i % 3 === 0) ? 3 : (i % 2 === 0) ? 2 : 1);
  }

  // Scattered earlier activity
  const sprinkle = [3, 5, 8, 9, 14, 17, 20, 23, 27, 30, 52, 55, 58, 60, 63, 66, 70, 74, 78, 81];
  for (const idx of sprinkle) {
    set(idx, (idx % 5 === 0) ? 3 : (idx % 3 === 0) ? 2 : 1);
  }

  return grid;
}

export const MOCK_STREAK_GRID = buildStreakGrid();
