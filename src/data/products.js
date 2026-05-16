// Single source of truth for the FEATURED MODS marquee.
// Swap-in real SKUs by editing this file — no React changes needed.
// Each product needs: slug, name, blurb, tag (or null), image (or null).
// When `image` is null the card falls back to the "// PRODUCT IMAGE"
// placeholder so the marquee never goes empty during a copy refresh.

export const PRODUCTS = [
  { slug: 'viper-shroud',  name: 'VIPER SHROUD',  blurb: 'Barrel-mounted tactical shroud with integrated rail system.', tag: '// POPULAR', image: null },
  { slug: 'hex-grip-pro',  name: 'HEX GRIP PRO',  blurb: 'Ergonomic foregrip with hexagonal texture pattern.',        tag: '// NEW',     image: null },
  { slug: 'phantom-stock', name: 'PHANTOM STOCK', blurb: 'Adjustable lightweight stock with cheek riser.',            tag: null,         image: null },
  { slug: 'apex-muzzle',   name: 'APEX MUZZLE',   blurb: 'Flash hider with spiral porting. Clean aesthetics.',        tag: '// LIMITED', image: null },
  { slug: 'tac-rail-kit',  name: 'TAC RAIL KIT',  blurb: 'Modular picatinny rail segments. Mount anywhere.',          tag: null,         image: null },
  { slug: 'ghost-mag',     name: 'GHOST MAG',     blurb: 'Extended magazine housing with window cutout.',             tag: '// NEW',     image: null },
];
