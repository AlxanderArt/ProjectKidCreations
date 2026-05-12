/* ProjectKidCreations — phase-four/badges.js
 * 12-badge catalog. Glyphs are bare unicode so they render in the mono
 * stack without a webfont dep. Rarity drives the ring color when unlocked.
 *
 * Rarity scale:
 *   common    → slate ring
 *   rare      → concrete ring
 *   epic      → accent ring
 *   legendary → accent ring + pulse
 */

export const BADGE_CATALOG = [
  {
    id: "verified",
    label: "VERIFIED",
    glyph: "◆",
    rarity: "rare",
    criteria: "Confirm your email after the drop link."
  },
  {
    id: "early_operator",
    label: "EARLY OPERATOR",
    glyph: "★",
    rarity: "legendary",
    criteria: "First 500 operators through the door."
  },
  {
    id: "profile_maxed",
    label: "PROFILE MAXED",
    glyph: "⬢",
    rarity: "epic",
    criteria: "Complete every profile field — avatar, shipping, comms."
  },
  {
    id: "first_build",
    label: "FIRST BUILD",
    glyph: "◉",
    rarity: "rare",
    criteria: "Submit your first build to the gallery."
  },
  {
    id: "day_one",
    label: "DAY-1 OPERATOR",
    glyph: "▲",
    rarity: "legendary",
    criteria: "Sign in on launch day."
  },
  {
    id: "returning",
    label: "RETURNING",
    glyph: "▼",
    rarity: "common",
    criteria: "Come back after a 7-day gap."
  },
  {
    id: "veteran",
    label: "VETERAN",
    glyph: "✦",
    rarity: "epic",
    criteria: "Reach 500 XP."
  },
  {
    id: "builder",
    label: "BUILDER",
    glyph: "✚",
    rarity: "rare",
    criteria: "Reach 100 XP."
  },
  {
    id: "beginner",
    label: "BEGINNER",
    glyph: "◇",
    rarity: "common",
    criteria: "Create your account."
  },
  {
    id: "connected",
    label: "CONNECTED",
    glyph: "⌬",
    rarity: "common",
    criteria: "Link a comms channel — Discord or SMS."
  },
  {
    id: "located",
    label: "LOCATED",
    glyph: "⌖",
    rarity: "common",
    criteria: "Add a shipping address."
  },
  {
    id: "eighteen_plus",
    label: "18+",
    glyph: "⚠",
    rarity: "rare",
    criteria: "Confirm age gate."
  }
];

export function findBadge(id) {
  return BADGE_CATALOG.find((b) => b.id === id) || null;
}
